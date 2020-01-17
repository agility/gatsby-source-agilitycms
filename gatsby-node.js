var agility = require('@agility/content-fetch')
var path = require('path')
var { logDebug, logInfo, logError, logWarning, logSuccess, asyncForEach } = require('./utils')
var { ContentResolver } = require("./content-resolver")
var { graphql } = require("gatsby")

exports.sourceNodes = async (args, configOptions) => {
	const { actions, createNodeId, createContentDigest, getNode, getNodes, store, cache, reporter, webhookBody } = args;
	const { createNode, deleteNode, deletePage, touchNode } = actions

	//create our page resolver
	const contentResolver = new ContentResolver({ getNode, createNodeId, createNode, createContentDigest, deleteNode });

	logInfo(`Sync Started (${process.env.NODE_ENV})...`);

	if (webhookBody && Object.keys(webhookBody).length > 0) {
		logSuccess(`Webhook being processed...`);
		logSuccess(JSON.stringify(webhookBody));
	}


	const aglClient = agility.getApi({
		guid: configOptions.guid,
		apiKey: configOptions.apiKey,
		isPreview: configOptions.isPreview,
		debug: configOptions.debug,
		baseUrl: configOptions.baseUrl
	})

	const languages = configOptions.languages;
	const channels = configOptions.channels;

	/**
	 * Source Sitemap + Pages ---
	 * @param {*} { language }
	 */
	const sourceSitemap = async ({ language }) => {

		const languageCode = language;

		logInfo(`Start Sitemap Sync - ${language} - ${JSON.stringify(channels)}`);
		//Loop through each channel
		await asyncForEach(channels, async (channel) => {

			const sitemapNodes = await aglClient.getSitemapFlat({ channelName: channel, languageCode: languageCode });

			if (!sitemapNodes) {
				logError(`Could not retrieve sitemap for ${channelName} (${languageCode}.`);
				return; //kickout
			}


			// Loop through each sitemapnode in sitemap
			await asyncForEach(Object.values(sitemapNodes), async (sitemapNode) => {

				// Add-in languageCode for this item so we can filter it by lang later
				sitemapNode.languageCode = languageCode;

				// Update the path to include languageCode (if multi-lingual site)
				if (configOptions.languages.length > 1) {
					sitemapNode.path = `/${languagePath}${sitemapNode.path}`;
				}

				// Now create a node for each sitemap entry as well

				// If we don't have a contentID property, add-in a negative value - this allows us to safely query for this property later...
				if (!sitemapNode.contentID) {
					sitemapNode.contentID = -1;
				}

				//stash this node in our temp cache for page resolving..
				contentResolver.addSitemapNode({ node: sitemapNode, languageCode });

				const sitemapNodeContent = JSON.stringify(sitemapNode);

				if (configOptions.debug) {
					logDebug(sitemapNodeContent);
				}


				let sitemapIDStr = `sitemap-${languageCode}-${sitemapNode.pageID}`;
				if (sitemapNode.contentID > 0) {
					//handle dynamic pages here....
					sitemapIDStr = `sitemap-${languageCode}-${sitemapNode.pageID}-${sitemapNode.contentID}`;
				}
				const sitemapNodeID = createNodeId(sitemapIDStr);

				const sitemapNodeMeta = {
					id: sitemapNodeID,
					parent: null,
					children: [],
					internal: {
						type: 'AgilitySitemap',
						content: "",
						contentDigest: createContentDigest(sitemapNode)
					}
				}
				const sitemapNodeToCreate = Object.assign({}, sitemapNode, sitemapNodeMeta);

				await createNode(sitemapNodeToCreate);

			})
		});

	}

	/**
	 * Process a content item in the local graphql storage.
	 * @param {The content item.} ci
	 * @param {The language code of the item.} languageCode
	 */
	const processContentItemNode = async (ci, languageCode) => {

		const nodeID = getContentNodeID(ci.contentID, languageCode);
		const nodeIDRefName = createNodeId(`agilitycontentref-${ci.contentID}-${languageCode}`);

		if (ci.properties.state === 3) {
			//*****  handle deletes *****
			//TODO: handle removing this item from any parent items...

			deleteNode({
				node: getNode(nodeID),
			});

			deleteNode({
				node: getNode(nodeIDRefName),
			});

			//remove any page dependancies we were tracking for this item...
			contentResolver.removeAgilityPageDependency({ contentID: ci.contentID, languageCode });

			logInfo(`${ci.contentID}-${languageCode} - content node deleted.`)
		} else {
			//*****  handle creates or updates *****

			//switch `fields` to 'agilityFields' - (fields is a reserved name)
			ci.agilityFields = ci.fields;
			delete ci.fields;

			// Add-in languageCode for this item so we can filter it by lang later
			ci.languageCode = languageCode;

			//stash this item in the page resolver for later...
			contentResolver.addContentByID({ content: ci });

		}


	}

	/**
	 * Actually resolve and store all the newly created content items.
	 */
	const processNewlySyncedItems = async () => {

		const allContentByID = contentResolver.getNewlySyncedConent();
		const depPageIDs = [];
		const depContentIDs = [];

		for (const languageCode in allContentByID) {
			const allContentByLanguage = allContentByID[languageCode];
			for (const contentID in allContentByLanguage) {
				let ci = allContentByLanguage[contentID];

				const { thesePageIDs, theseParentContentIDs } = await processContentItem(ci);

				//only store the unique ones...
				thesePageIDs.forEach((pageID) => {
					if (depPageIDs.indexOf(pageID) == -1) depPageIDs.push(pageID);
				});

				theseParentContentIDs.forEach((cid) => {
					if (depContentIDs.indexOf(cid) == -1) depContentIDs.push(cid);
				});
			}


		}

		return { depPageIDs, depContentIDs };

	}

	const getContentNodeID = (contentID, languageCode) => {
		return createNodeId(`agilitycontent-${contentID}-${languageCode}`);
	}

	const processContentItem = async (ci) => {

		const languageCode = ci.languageCode;

		//expand the relationships on this...
		ci = await contentResolver.expandContent({ contentItem: ci, languageCode, pageID: -1, parentContentID: -1, depth: 0 });

		//stash the item by reference name
		contentResolver.addContentByRefName({ content: ci });

		//generate the node ids for graphql
		const nodeID = getContentNodeID(ci.contentID, languageCode);
		const nodeIDRefName = createNodeId(`agilitycontentref-${ci.contentID}-${languageCode}`);

		const nodeContent = JSON.stringify(ci);

		if (configOptions.debug) {
			logDebug(nodeContent);
		}

		//*** create it once as an Item indexed by contentID
		const nodeMeta = {
			id: nodeID,
			parent: null,
			children: [],
			internal: {
				type: `AgilityContent`, //_${ci.properties.definitionName}`,
				content: nodeContent,
				contentDigest: createContentDigest(ci)
			}
		}
		const node = Object.assign({}, ci, nodeMeta);
		await createNode(node);

		//*** create it a second time referenced by the Content Def
		const nodeMeta2 = {
			id: nodeIDRefName,
			parent: null,
			children: [],
			internal: {
				type: `AgilityContent_${ci.properties.definitionName}`,
				content: nodeContent,
				contentDigest: createContentDigest(ci)
			}
		}
		const node2 = Object.assign({}, ci, nodeMeta2);
		await createNode(node2);

		//resolve the dependant page and content ids for this item
		let thesePageIDs = await contentResolver.getDependantPageIDs({ contentID: ci.contentID, languageCode });
		let theseParentContentIDs = await contentResolver.getDependantContentIDs({ contentID: ci.contentID, languageCode });

		return { thesePageIDs, theseParentContentIDs };

	}


	const processDependantContentID = async (contentID, languageCode) => {




		const nodeID = getContentNodeID(contentID, languageCode);
		const contentNode = getNode(nodeID);
		if (contentNode == null) return;

		const json = contentNode.internal.content;
		const contentItem = JSON.parse(json);

		// Add-in languageCode for this item so we can filter it by lang later
		contentItem.languageCode = languageCode;

		//stash this item for lookup later...
		contentResolver.addContentByID({ content: contentItem });

		//TODO: if there are more dependant ids uncovered here, process them recursively...
		const { thesePageIDs, theseParentContentIDs } = await processContentItem(contentItem);

		return { thesePageIDs, theseParentContentIDs };

	}

	/**
	 * Resolve the dependancies on an existing page node.
	 */
	const processDependantPageID = async (pageID, languageCode) => {

		const nodeID = createNodeId(`agilitypage-${languageCode}-${pageID}`);
		const pageNode = getNode(nodeID);
		if (pageNode == null) return;

		const json = pageNode.internal.content;
		const pageItem = JSON.parse(json);

		await processPageNode(pageItem, languageCode);

	}

	/**
	* Process a page item in the local graphql storage.
	* @param {The page item.} pageItem
	* @param {The language code of the item.} languageCode
	*/
	const processPageNode = async (pageItem, languageCode) => {

		const nodeID = createNodeId(`agilitypage-${languageCode}-${pageItem.pageID}`);

		if (pageItem.properties.state === 3) {

			//*****  handle deletes *****
			deleteNode({
				node: getNode(nodeID)
			});

			logInfo(`${pageItem.pageID}-${languageCode} - page node deleted.`)
		} else {
			//*****  handle creates or updates *****

			// Add-in languageCode for this item so we can filter it by lang later
			pageItem.languageCode = languageCode;

			//get the previous page item...
			const existingPageNode = getNode(nodeID);

			//expand this page's modules and content out
			pageItem = await contentResolver.expandPage({ page: pageItem, existingPageNode });

			const nodeContent = JSON.stringify(pageItem);

			if (configOptions.debug) {
				logDebug(nodeContent);
			}

			const nodeMeta = {
				id: nodeID,
				parent: null,
				children: [],
				pageID: pageItem.pageID,
				languageCode: languageCode,
				pageJson: nodeContent,
				internal: {
					type: `AgilityPage`,
					content: nodeContent,
					contentDigest: createContentDigest(pageItem)
				}
			}


			await createNode(nodeMeta);

		}

		//return any dependencies to the calling function...
		const state = store.getState();
		let paths = state.componentDataDependencies.nodes[nodeID];

		if (paths && paths.length) {
			return paths;
		}

		return [];
	}

	/**
	 * Sync all the content items in the specified language.
	 */
	const syncAllContentItems = async ({ aglClient, language, syncState }) => {

		try {
			let ticks = 0;
			if (syncState && syncState.items[language]) {
				ticks = syncState.items[language].ticks;
			}


			do {
				//sync content items...
				const syncRet = await aglClient.syncContentItems({
					ticks: ticks,
					pageSize: 100,
					languageCode: language
				});

				const syncItems = syncRet.items;

				//if we don't get anything back, kick out
				if (syncItems.length === 0) {
					break;
				}

				for (let index = 0; index < syncItems.length; index++) {
					await processContentItemNode(syncItems[index], language);
				}

				ticks = syncRet.ticks;
				logInfo(`Content Sync returned ${syncItems.length} items - ticks: ${ticks}`);

				if (!syncState.items[language]) syncState.items[language] = {};
				syncState.items[language].ticks = ticks;


			} while (ticks > 0)


			//process all the newly synced items...
			const { depPageIDs, depContentIDs } = await processNewlySyncedItems();

			console.log("Dep Content:", depContentIDs)
			console.log("Dep Pages:", depPageIDs)

			//keep track of any pages we need to reprocess
			syncState.dependantPageIDs = depPageIDs;


			//reprocess any dependant content items
			await asyncForEach(depContentIDs, async (contentID) => {
				await processDependantContentID(contentID, language);
			});


		} catch (error) {
			if (console) console.error("Error occurred in content sync.", error);
		}

		return syncState;

	};

	/**
	 * Sync all the pages in the specified language.
	 */
	const syncAllPages = async ({ aglClient, language, syncState }) => {

		let pagesChanged = false;
		try {
			let ticks = 0;
			if (syncState && syncState.pages[language]) {
				ticks = syncState.pages[language].ticks;

			}

			let sitemapSourced = false;

			do {
				//sync content items...
				const syncRet = await aglClient.syncPageItems({
					ticks: ticks,
					pageSize: 100,
					languageCode: language
				});

				const syncItems = syncRet.items;

				//if we don't get anything back, kick out
				if (syncItems.length === 0) {
					break;
				}

				if (!sitemapSourced) {
					sitemapSourced = true;
					//we've synced at least 1 page - source sitemap...
					await sourceSitemap({ language });

				}

				pagesChanged = true;

				for (let index = 0; index < syncItems.length; index++) {

					let pageToProcess = syncItems[index];
					await processPageNode(pageToProcess, language);


					//make sure this page isn't in the list of pages we "HAVE" to process.
					syncState.dependantPageIDs = syncState.dependantPageIDs.filter((pid) => pid != pageToProcess.pageID)

				}

				ticks = syncRet.ticks;
				logInfo(`Page Sync returned ${syncItems.length} pages - ticks: ${ticks}`);

				if (!syncState.pages[language]) syncState.pages[language] = {};
				syncState.pages[language].ticks = ticks;


			} while (ticks > 0)

			//re-process any pages that have had dependant content items updated
			if (syncState.dependantPageIDs.length > 0) {
				logInfo(`Processing ${syncState.dependantPageIDs.length} dependant pages.`);

				syncState.dependantPageIDs.forEach(async (pageID) => {

					await processDependantPageID(pageID, language);

				});

			}

		} catch (error) {
			if (console) console.error("Error occurred in page sync.", error);
		}

		return {
			syncState, pagesChanged
		};

	};


	/**
	 * Touch the previous nodes so that they don't get erased in this build
	 */
	const touchAllNodes = async () => {

		let nodes = getNodes();

		let count = 0;
		await asyncForEach(nodes, async (node) => {
			//only touch the Agility nodes that are NOT sitemap nodes
			const nodeType = node.internal.type.toLowerCase();
			if (nodeType.indexOf("agility") != -1
				&& nodeType.indexOf("agilitysitemap") === -1) {
				await touchNode({ nodeId: node.id });
				count++;
			}
		});

		logSuccess(`Touched ${count} nodes`);

	}

	const touchAllSitemapNodes = async () => {

		let nodes = getNodes();

		let count = 0;
		await asyncForEach(nodes, async (node) => {
			//only touch the Agility nodes that are NOT sitemap nodes
			const nodeType = node.internal.type.toLowerCase();
			if (nodeType.indexOf("agility") != -1
				&& nodeType.indexOf("agilitysitemap") != -1) {
				await touchNode({ nodeId: node.id });
				count++;
			}
		});

		logSuccess(`Touched ${count} sitemap nodes`);

	}


	/**
	 * Save the sync state
	 */
	const saveSyncState = async ({ syncState }) => {

		//{"items":{"en-us":{"ticks":309}},"pages":{"en-us":{"ticks":95}}}

		const nodeMeta = {
			id: "agilitysyncstate",
			parent: null,
			children: [],
			internal: {
				type: `AgilitySyncState`, //_${ci.properties.definitionName}`,
				content: "",
				contentDigest: createContentDigest(syncState)
			}
		}
		const node = Object.assign({}, syncState, nodeMeta);

		await createNode(node);



		// const p = new Promise((resolve, reject) => {
		//   try {

		//     const writeTheFile = async () => {
		//       const json = JSON.stringify(syncState);

		//       fs.writeFile(stateFilePath, json, (err) => {
		//         resolve;
		//       });
		//     };

		//     fs.stat(stateFilePath, (err, stats) => {

		//       if (!stats) {
		//         //create the folder...
		//         fs.mkdir(agilityCacheFolder, (err) => {
		//           writeTheFile();
		//         });
		//       } else {
		//         writeTheFile();
		//       }
		//     });

		//   } catch (err3) {
		//     console.error("Error occurred writing sync file", err3);
		//   }
		//   resolve();

		// });

		// return p;

	}

	const getSyncState = async () => {

		const syncNode = await getNode("agilitysyncstate");
		return syncNode;


	}


	//**** DO THE WORK ****
	const doTheWork = async () => {

		//get the saved sync state
		let syncState = await getSyncState();

		if (!syncState) {
			syncState = {
				items: {},
				pages: {}
			};
		}

		//reset the pages that we have to update on this round...
		syncState.dependantPageIDs = [];

		//mark all the previous nodes as touched so they don't get reset...
		await touchAllNodes();

		//loop all the languages...
		await asyncForEach(languages, async (language) => {

			logInfo(`Start Sync Content - ${language}`);
			syncState = await syncAllContentItems({ aglClient, language, syncState });
			logSuccess(`Done Sync Content - ${language}`);

			logInfo(`Start Sync Pages - ${language}`);
			let pageSyncRet = await syncAllPages({ aglClient, language, syncState });
			syncState = pageSyncRet.syncState;
			if (!pageSyncRet.pagesChanged) {
				//if we haven't changed any pages, mark all the sitemap nodes as "touched"
				await touchAllSitemapNodes();
			}

			logSuccess(`Done Page Sync - ${language}`);

			//persist the state to the file system
			await saveSyncState({ syncState });

			logInfo(`Done Sync - ${language}`);


		});

	};

	return doTheWork();

}

exports.createPages = async (args, configOptions) => {
	const { graphql, actions, getNode, createNodeId, createContentDigest, store } = args;
	const { createPage, deletePage, createNode, createRedirect, createPageDependency } = actions;

	logInfo(`Create Pages Started...`);

	let isPreview = configOptions.isPreview;
	let pageTemplate = null;
	if (configOptions.defaultPageTemplate) {
		pageTemplate = path.resolve(configOptions.defaultPageTemplate);
	}

	const queryAllSitemapNodes = async () => {
		const result = await graphql(`query SitemapNodesQuery {
				allAgilitySitemap {
					nodes {
						name
						contentID
						pageID
						path
						title
						menuText
						languageCode
					}
				}
			}`);

		if (result.errors) {
			throw result.errors
		}

		return result.data;
	};

	const createAgilityPage = async (sitemapNode, isHomePage) => {

		if (sitemapNode.isFolder) return;

		let languageCode = sitemapNode.languageCode;
		let pagePath = sitemapNode.path;
		if (isHomePage) {

			//create a redirect from sitemapNode.path to /
			await createRedirect({
				fromPath: sitemapNode.path,
				toPath: "/",
				isPermantent: true,
				redirectInBrowser: true
			});

			pagePath = "/";
		}

		// Do we have this page in other languages? If so, add-in some info for them so they can be found/accessed easily

		//HACK is this neccessary?
		// sitemapNode.nodesInOtherLanguages = [];
		// if (configOptions.languages.length > 1) {
		//   result.data.allAgilitySitemapNode.nodes.forEach(smn => {
		//     // If we found a page with the same ID and its NOT this same page
		//     if (smn.pageID === sitemapNode.pageID && smn.languageCode !== sitemapNode.languageCode) {

		//       let languageForThisOtherNode = configOptions.languages.find(l => {
		//         return l.code === smn.languageCode
		//       })

		//       sitemapNode.nodesInOtherLanguages.push({
		//         name: smn.name,
		//         pageID: smn.pageID,
		//         path: smn.path,
		//         menuText: smn.menuText,
		//         languageName: languageForThisOtherNode.name,
		//         languageCode: languageForThisOtherNode.code
		//       });
		//     }
		//     return;
		//   })
		// }

		let createPageArgs = {
			path: pagePath,
			component: pageTemplate,
			context: {
				pageID: sitemapNode.pageID,
				contentID: sitemapNode.contentID,
				languageCode: sitemapNode.languageCode,
				title: sitemapNode.title,
				isPreview: isPreview
			}
		}

		let languageForThisPage = configOptions.languages.find(lang => {
			return lang === sitemapNode.languageCode
		})

		if (!languageForThisPage) {
			logError(`The language for the page ${pagePath} with languageCode ${languageCode} could not be found.`);
			return; //kickout
		}

		let homePagePath = languageForThisPage.homePagePath;

		if (configOptions.languages.length > 1) {
			homePagePath = `/ ${languageForThisPage.path} ${languageForThisPage.homePagePath} `;
		}

		// if (homePagePath && homePagePath === pagePath) {

		//   logInfo(`Found homepage for ${languageForThisPage.code}(${homePagePath}) in sitemap.`)

		//   if (configOptions.languages.length > 1) {
		//     createPageArgs.path = `/ ${languageForThisPage.path}`
		//   } else {
		//     createPageArgs.path = `/ `
		//   }

		//   createPage(createPageArgs);

		//   if (configOptions.debug) {
		//     logDebug(JSON.stringify(createPageArgs));
		//   }

		//   logSuccess(`Index Page ${createPageArgs.path} (${sitemapNode.languageCode}) created.`);

		//   //create a redirect from the actual page to the root page
		//   createRedirect({
		//     fromPath: pagePath,
		//     toPath: createPageArgs.path,
		//     isPermantent: true,
		//     redirectInBrowser: true
		//   });

		//   logSuccess(`Redirect from ${pagePath} to ${createPageArgs.path} created`);

		// } else {

		createPage(createPageArgs);

		if (configOptions.debug) {
			logDebug(JSON.stringify(createPageArgs));
		}

		// logSuccess(`Page ${createPageArgs.path} (${sitemapNode.languageCode}) created.`);
		//}

	}


	const sitemapNodes = await queryAllSitemapNodes();
	if (sitemapNodes == null) {
		logWarning(`Could not get sitemap node(s)`)
		return;
	}

	let isHomePage = true;

	//loop all nodes we returned...
	return asyncForEach(sitemapNodes.allAgilitySitemap.nodes, async (sitemapNode) => {
		await createAgilityPage(sitemapNode, isHomePage);
		isHomePage = false;
	});

	// Create default language path redirect (if required)
	// if (configOptions.languages.length > 1) {
	//   const defaultLanguage = configOptions.languages[0];
	//   createRedirect({
	//     fromPath: '/',
	//     toPath: `/ ${defaultLanguage.path} `,
	//     isPermantent: true,
	//     redirectInBrowser: true
	//   })
	//   logSuccess(`Redirect created for default language path from / to ${defaultLanguage.path} `)
	// }

}


exports.createResolvers = (args) => {

	return;

	// const { createResolvers, getNode, createNodeId, createNode, createContentDigest } = args;

	// const contentResolver = new ContentResolver({ getNode, createNodeId, createNode, createContentDigest });


	// const resolvers = {

	// 	AgilityPage: {

	// 		pageJson: {
	// 			resolve: async (source, args, context, info) => {

	// 				const page = JSON.parse(source.pageJson);
	// 				console.log("r1", page)
	// 				for (const zoneName in page.zones) {
	// 					if (page.zones.hasOwnProperty(zoneName)) {
	// 						const zone = page.zones[zoneName];
	// 						let newZone = [];
	// 						await asyncForEach(zone, async (module) => {
	// 							console.log("expanding", zoneName, zone);
	// 							let contentID = module.item.contentID;
	// 							if (!contentID) contentID = module.item.contentid;

	// 							const contentItem = await contentResolver.expandContentByID({
	// 								contentID,
	// 								languageCode: page.languageCode,
	// 								pageID: page.pageID,
	// 								parentContentID: -1,
	// 								depth: 0
	// 							});
	// 							if (contentItem != null) {
	// 								//add this module's content item into the zone
	// 								module.item = contentItem;
	// 							}

	// 						});

	// 					}
	// 				}

	// 				console.log("r2", page)
	// 				return JSON.stringify(page);

	// 			}
	// 		},
	// 	},
	// }
	// createResolvers(resolvers)
}







