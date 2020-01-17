var { logDebug, logInfo, logError, logWarning, logSuccess, asyncForEach } = require('./utils')


class ContentResolver {

	constructor({ getNode, createNodeId, createNode, createContentDigest, deleteNode }) {
		this.getNode = getNode;
		this.createNode = createNode;
		this.createNodeId = createNodeId;
		this.deleteNode = deleteNode;
		this.createContentDigest = createContentDigest;
		this.contentByID = {};
		this.contentByRefName = {};
		this.sitemapNodes = {};
	}


	async expandPage({ page, existingPageNode }) {


		const languageCode = page.languageCode;
		const pagePath = page.path;
		const pageID = page.pageID;

		//if we have an existing page, copy over the resolved zones from it...
		if (existingPageNode && existingPageNode.internal && existingPageNode.internal.content) {
			const pJSON = existingPageNode.internal.content;
			const existingPage = JSON.parse(pJSON);

			for (const zoneName in existingPage.zones) {
				const existingZone = existingPage.zones[zoneName];
				const newZone = page.zones[zoneName];

				if (existingZone != null) {

					const replacedZones = [];

					newZone.forEach((newModule) => {
						const existingModule = existingZone.find((m) => {
							return m.item.contentID === newModule.item.contentID || m.item.contentID === newModule.item.contentid
						});

						if (existingModule) {
							replacedZones.push(existingModule);
						} else {
							replacedZones.push(newModule);
						}
					});

					page.zones[zoneName] = replacedZones;

				}
			}
		}


		let newZones = {};

		for (const zoneName in page.zones) {
			if (page.zones.hasOwnProperty(zoneName)) {
				const zone = page.zones[zoneName];
				let newZone = [];
				await asyncForEach(zone, async (module) => {

					let contentID = module.item.contentID;
					if (!contentID) contentID = module.item.contentid;

					const contentItem = await this.expandContentByID({ contentID, languageCode, pageID, parentContentID: -1, depth: 0 });
					if (contentItem != null) {
						//add this module's content item into the zone
						module.item = contentItem;
					}

				});

			}
		}

		return page;

	}


	addContentByID({ content }) {

		const languageCode = content.languageCode;
		const contentID = content.contentID;

		if (!this.contentByID[languageCode]) {
			this.contentByID[languageCode] = {}
		}

		this.contentByID[languageCode][contentID] = content;

	}

	addContentByRefName({ content }) {
		const refName = content.properties.referenceName;
		const languageCode = content.languageCode;

		if (!this.contentByRefName[languageCode]) {
			this.contentByRefName[languageCode] = {}
			this.contentByRefName[languageCode][refName] = content;
		}
	}

	getNewlySyncedConent() {
		return this.contentByID;
	}

	addSitemapNode({ node, languageCode }) {

		if (!this.sitemapNodes[languageCode]) this.sitemapNodes[languageCode] = {};

		let contentID = node.contentID;
		if (!contentID) contentID = -1;

		const key = `${node.pageID}-${contentID}`

		this.sitemapNodes[languageCode][key] = node;
	}

	getSitemapNode({ pageID, languageCode, contentID }) {

		if (!contentID) contentID = -1;

		const key = `${pageID}-${contentID}`

		if (!this.sitemapNodes[languageCode]) return null;
		return this.sitemapNodes[languageCode][key];

	}

	/**
	   * Expands linked content given a page id.
	   * @param {*} { contentID, languageCode, pageID, depth }
	   * @returns
	   */
	async expandContentByID({ contentID, languageCode, pageID, parentContentID, depth, maxDepth, linkedItemExists }) {

		if (!this.contentByID[languageCode]) return null;

		let item = this.contentByID[languageCode][contentID];
		if (item == null && !linkedItemExists) {
			//if the item wasn't available in our cache
			//fall back on the GraphQL ONLY if we haven't resolved this item
			item = await this.queryContentItem({ contentID, languageCode });

			//since we pulled this from graphql, don't traverse it any deeper
			maxDepth = 0;
		}

		if (item == null) return null;

		if (!maxDepth) maxDepth = 3;

		//convert the object to JSON and back to avoid circular references...
		//THIS IS LAME- SOMEONE PLEASE FIX
		const json = JSON.stringify(item);
		item = JSON.parse(json);



		//track the dependency for this node...
		await this.addAgilityPageDependency({ pageID, contentID, languageCode });
		await this.addAgilityContentDependency({ parentContentID, contentID, languageCode })

		return await this.expandContent({ contentItem: item, languageCode, pageID, parentContentID, depth, maxDepth });

	}

	/**
	 * Expand any linked content based on the json.
	 * @param {*} { item, languageCode, pageID, depth }
	 * @returns The expanded content item.
	 */
	async expandContent({ contentItem, languageCode, pageID, parentContentID, depth, maxDepth }) {

		if (!maxDepth) maxDepth = 3;

		const contentID = contentItem.contentID;

		//only traverse as deep as we are supposed to...
		if (depth < maxDepth) {

			const agilityFields = contentItem.agilityFields;
			const newDepth = depth + 1;

			//*** loop all the fields */
			for (const fieldName in agilityFields) {
				if (agilityFields.hasOwnProperty(fieldName)) {
					let fieldValue = agilityFields[fieldName];

					//*** pull in the linked content by id */
					if ((fieldValue.contentID && parseInt(fieldValue.contentID) > 0)
						|| (fieldValue.contentid && parseInt(fieldValue.contentid) > 0)) {
						let linkedContentID = parseInt(fieldValue.contentID);
						if (isNaN(linkedContentID)) linkedContentID = parseInt(fieldValue.contentid);

						const linkedItemExists = fieldValue.item != undefined && fieldValue.item != null;

						//expand this content item...
						const linkedContentItem = await this.expandContentByID({
							contentID: linkedContentID,
							languageCode,
							pageID,
							parentContentID: contentID,
							depth: newDepth,
							maxDepth: 1,
							linkedItemExists
						})
						if (linkedContentItem != null) {
							//attach it to the field value..
							fieldValue.item = linkedContentItem;
						}

					}

					//*** pull in the linked content by multiple ids */
					else if (fieldValue.sortids && fieldValue.sortids.split) {
						//pull in the linked content by multiple ids

						const existingItems = fieldValue.items || [];

						const linkedContentItems = [];
						const linkedContentIDs = fieldValue.sortids.split(',');

						for (const i in linkedContentIDs) {
							const linkedContentID = parseInt(linkedContentIDs[i]);
							if (linkedContentID > 0) {

								const existingItem = existingItems.find(c => c.contentID == linkedContentID);
								const linkedItemExists = existingItem != null;

								//expand this content item...
								const linkedContentItem = await this.expandContentByID({
									contentID: linkedContentID,
									languageCode,
									pageID,
									parentContentID: contentID,
									depth: newDepth,
									maxDepth: 1,
									linkedItemExists
								})
								if (linkedContentItem != null) {
									//add it to the array
									linkedContentItems.push(linkedContentItem);
								} else if (existingItem != null) {
									//fall back on the current item if we need to
									linkedContentItems.push(existingItem);
								}
							}
						}

						//attach these items to the field value
						fieldValue.items = linkedContentItems;
					}

					//*** pull in the linked content by reference name */
					else if (fieldValue.referencename) {

						let lst = await this.getContentItemsByRefName({ refName: fieldValue.referencename, languageCode });
						const existingItems = fieldValue.items || [];
						if (lst != null) {
							await asyncForEach(lst, async (listItem) => {

								const json = JSON.stringify(listItem);
								const thisItem = JSON.parse(json);

								const existingItem = existingItems.find(c => c.contentID == linkedContentID);
								const linkedItemExists = existingItem != null;

								//track the dependency for this node...
								await addAgilityPageDependency({ pageID, contentID: thisItem.contentID, languageCode });
								await addAgilityContentDependency({ parentContentID: contentID, contentID: thisItem.contentID, languageCode });

								let linkedContentItem = await expandContent({
									contentItem: thisItem,
									languageCode,
									pageID,
									parentContentID: contentID,
									depth: newDepth,
									maxDepth: 1
								});
								if (linkedContentItem != null) {
									lst.push(linkedContentItem);
								}

							});
						} else {
							lst = [];
						}

						//merge this with the existing list...
						let itemsToKeep = existingItems.filter(x => lst.indexOf(c => c.contentID == x.contentID) == -1);

						//assign the new list to the field value
						fieldValue.items = lst.concat(itemsToKeep);

					}

				}

			}
		}


		return contentItem;
	}

	async getDependantPageIDs({ contentID, languageCode }) {
		const depNodeID = this.createNodeId(`agility-page-dep-${contentID}-${languageCode}`);
		let depNode = await this.getNode(depNodeID);
		if (depNode != null) {
			return depNode.pageIDs;
		}

		return [];
	}

	async getDependantContentIDs({ contentID, languageCode }) {
		const depNodeID = this.createNodeId(`agility-content-dep-${contentID}-${languageCode}`);
		let depNode = await this.getNode(depNodeID);
		if (depNode != null) {
			return depNode.parentContentIDs;
		}

		return [];
	}

	/**
	 * Add a dependancy for this content item onto the current page.
	 * @param {*} { pageID, contentID, languageCode }
	 * @memberof ContentResolver
	 */
	async addAgilityPageDependency({ pageID, contentID, languageCode }) {

		if (pageID < 1) return;

		//track the dependency in GraphQL
		const depNodeID = this.createNodeId(`agility-page-dep-${contentID}-${languageCode}`);
		let depNode = await this.getNode(depNodeID);

		let pageIDs = [pageID];

		if (depNode != null) {
			if (depNode.pageIDs.indexOf(pageID) != -1) {
				//we already have a dependancy here, kick out
				return;
			}
			depNode.pageIDs.push(pageID)
			pageIDs = depNode.pageIDs;
		}

		const obj = {
			contentID: contentID,
			languageCode: languageCode,
			pageIDs: pageIDs
		};

		const nodeMeta = {
			id: depNodeID,
			parent: null,
			children: [],
			internal: {
				type: `AgilityPageDependency`,
				content: "",
				contentDigest: this.createContentDigest(obj)
			}
		}
		depNode = Object.assign({}, obj, nodeMeta);

		await this.createNode(depNode);

	}
	/**
	 * Track the content dependency
	 *
	 * @param {*} { parentContentID, contentID, languageCode }
	 * @returns
	 * @memberof ContentResolver
	 */
	async addAgilityContentDependency({ parentContentID, contentID, languageCode }) {

		if (parentContentID < 1) return;


		//track the dependency in GraphQL
		const depNodeID = this.createNodeId(`agility-content-dep-${contentID}-${languageCode}`);
		let depNode = await this.getNode(depNodeID);

		let parentContentIDs = [parentContentID];

		if (depNode != null) {
			if (depNode.parentContentIDs.indexOf(parentContentID) != -1) {
				//we already have a dependancy here, kick out
				return;
			}
			depNode.parentContentIDs.push(parentContentID)
			parentContentIDs = depNode.parentContentIDs;
		}

		const obj = {
			contentID: contentID,
			languageCode: languageCode,
			parentContentIDs: parentContentIDs
		};

		const nodeMeta = {
			id: depNodeID,
			parent: null,
			children: [],
			internal: {
				type: `AgilityContentDependency`,
				content: "",
				contentDigest: this.createContentDigest(obj)
			}
		}
		depNode = Object.assign({}, obj, nodeMeta);

		await this.createNode(depNode);

	}

	async removeAgilityPageDependency({ contentID, languageCode }) {
		const depNodeID = this.createNodeId(`agility-page-dep-${contentID}-${languageCode}`);

		await this.deleteNode({
			node: this.getNode(depNodeID),
		});
	}

	async removeAgilityContentDependency({ contentID, languageCode }) {
		const depNodeID = this.createNodeId(`agility-content-dep-${contentID}-${languageCode}`);

		await this.deleteNode({
			node: this.getNode(depNodeID),
		});
	}

	getContentItemsByRefName({ refName, languageCode }) {
		if (!this.contentByRefName[languageCode]) return null;

		return this.contentByRefName[languageCode][refName];
	}

	async queryContentItem({ contentID, languageCode }) {

		const nodeID = this.createNodeId(`agilitycontent-${contentID}-${languageCode}`);

		const contentNode = await this.getNode(nodeID);

		if (!contentNode || !contentNode.internal || !contentNode.internal.content) return null;

		const item = JSON.parse(contentNode.internal.content);

		return item;

	}


}


module.exports = {
	ContentResolver
}
