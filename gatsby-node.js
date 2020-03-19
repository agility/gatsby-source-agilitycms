let path = require('path')
let { logDebug, logInfo, logError, logWarning, logSuccess, asyncForEach } = require('./util')
let agilitySync = require('@agility/content-sync')
let syncInterfaceGatsby = require('./sync-interface-gatsby')

//SOURCE NODES ***********************************************************************************************
exports.sourceNodes = async (args, configOptions) => {
	const { actions, createNodeId, createContentDigest, getNode, getNodes, store, cache, reporter } = args;
	const { createNode, deleteNode, deletePage, touchNode } = actions

	const languageCodes = resolveLanguageCodes(configOptions.languages);
	const channelsRefs = resolveChannelRefNames(configOptions.channels);

	//set up our Agility CMS Sync Client
	const syncClient = agilitySync.getSyncClient({
		guid: configOptions.guid,
		apiKey: configOptions.apiKey,
		isPreview: configOptions.isPreview,
		debug: configOptions.debug,
		baseUrl: configOptions.baseUrl,
		channels: channelsRefs,
		languages: languageCodes,
		store: {
			//use gatsby sync interface
			interface: syncInterfaceGatsby,
			options: {
				getNode,
				createNodeId,
				createNode,
				createContentDigest,
				deleteNode
			}
		}
	});

	logInfo(`Source Nodes Started (${process.env.NODE_ENV})...`);

	//touch the nodes so that the ones we don't update stay persistent
	await touchAllNodes({ getNodes, touchNode });

	//start the sync, check what has changed and refresh source nodes
	await syncClient.runSync();

	logInfo(`Creating sitemap nodes...`);

	//TODO: Do we need to do this every time?
	await createSitemapSourceNodes({ createNode, createNodeId, createContentDigest, channelsRefs, languageCodes, syncClient })

	logInfo(`Source Nodes Completed.`);
}

//CREATE PAGES ***********************************************************************************************
exports.createPages = async (args, configOptions) => {

	const { graphql, actions, getNode, createNodeId, createContentDigest, store } = args;
	const { createPage, deletePage, createNode, createRedirect, createPageDependency } = actions;

	const languages = configOptions.languages;
	const channelsRefs = resolveChannelRefNames(configOptions.channels);
	const debug = configOptions.debug;
	const isMultiLanguage = languages.length > 1;

	logInfo(`Create Pages Started...`);

	let isPreview = configOptions.isPreview;
	let pageTemplate = null;

	if (configOptions.masterPageTemplate) {
		pageTemplate = path.resolve(configOptions.masterPageTemplate);
	}

	//set up our Agility CMS Sync Client
	const syncClient = agilitySync.getSyncClient({
		guid: configOptions.guid,
		apiKey: configOptions.apiKey,
		isPreview: configOptions.isPreview,
		debug: configOptions.debug,
		baseUrl: configOptions.baseUrl,
		channels: configOptions.channels,
		languages: configOptions.languages,
		store: {
			//use gatsby sync interface
			interface: syncInterfaceGatsby,
			options: {
				getNode,
				createNodeId,
				createNode,
				createContentDigest
			}
		}
	});


	await createPagesInEachLanguage({ syncClient, languages, channelsRefs, createPage, createRedirect, pageTemplate, isPreview, debug, isMultiLanguage })

	//HACK: create a dummy page for `gatsby develop` redirects on the client-side for dynamic preview urls
	await createClientRedirectPageForPreviewNode({ createPage });

}

//CREATE RESOLVERS *******************************************************************************************
exports.createResolvers = (args) => {

	const { createResolvers, getNode, createNodeId, createNode, createContentDigest } = args;


	const getContentItem = async ({ contentID, languageCode, context, depth }) => {

		const preStr = `agility${languageCode}-item-${contentID}`.toLowerCase();
		const nodeIDStr = createNodeId(preStr);

		const gItem = context.nodeModel.getNodeById({
			id: nodeIDStr,
			type: "agilityitem",
		});

		if (!gItem) return null;

		const itemJson = gItem.internal.content;
		const contentItem = JSON.parse(itemJson);

		//expand the item if we have to...
		if (depth > 0) {

			for (const fieldName in contentItem.customFields) {
				const fieldValue = contentItem.customFields[fieldName];
				if (!fieldValue) continue;
				if (fieldValue.contentid > 0) {
					//single linked item
					const childItem = await getContentItem({ contentID: fieldValue.contentid, languageCode, context, depth: depth - 1 });
					if (childItem != null) contentItem.customFields[fieldName] = childItem;
				} else if (fieldValue.sortids && fieldValue.sortids.split) {
					//multi linked item
					const sortIDAry = fieldValue.sortids.split(',');
					const childItems = [];
					for (const childItemID of sortIDAry) {
						const childItem = await getContentItem({ contentID: childItemID, languageCode, context, depth: depth - 1 });
						if (childItem != null) childItems.push(childItem);
					}

					contentItem.customFields[fieldName] = childItems;

				}
			}

		}

		return contentItem;

	}

	const resolvers = {

		agilitypage: {

			pageJson: {
				resolve: async (source, args, context, info) => {

					const languageCode = source.languageCode;

					const pageJSON = source.internal.content;
					const pageItem = JSON.parse(pageJSON);
					let depth = 3;

					for (const zoneName in pageItem.zones) {
						const zone = pageItem.zones[zoneName];

						for (const mod of zone) {
							const moduleItem = await getContentItem({ contentID: mod.item.contentid, languageCode, context, depth: depth - 1 });
							mod.item = moduleItem;
						}
					}

					return JSON.stringify(pageItem);

				}
			}
		},
		agilityitem: {
			itemJson: {
				resolve: async (source, args, context, info) => {
					const languageCode = source.languageCode;
					const contentID = source.itemID;

					const itemExpanded = await getContentItem({ contentID, languageCode, context, depth: 3 });

					return JSON.stringify(itemExpanded);
				}
			}
		}
	}
	createResolvers(resolvers)
}

const createSitemapSourceNodes = async ({ createNode, createNodeId, createContentDigest, channelsRefs, languageCodes, syncClient }) => {

	//only support one channel for now (first channel)
	let channelName = channelsRefs[0];

	await asyncForEach(languageCodes, async (languageCode) => {

		//get the sitemap from the local store
		let sitemap = await syncClient.store.getSitemap({ channelName, languageCode });

		if (!sitemap) {
			throw new Error(`Could not get the sitemap node(s) for channel ${channelName} in language ${languageCode}`);
		}

		//create the sitemap nodes...
		for (const pagePath in sitemap) {

			const sitemapNode = sitemap[pagePath];

			const nodeID = createNodeId(`sitemap-${sitemapNode.pageID}-${sitemapNode.contentID}`);

			const nodeMeta = {
				id: nodeID,
				parent: null,
				children: [],
				languageCode: languageCode,
				pagePath: pagePath,
				internal: {
					type: "agilitySitemapNode",
					content: "",
					contentDigest: createContentDigest(sitemapNode)
				}
			}

			const nodeToCreate = Object.assign({}, sitemapNode, nodeMeta);

			await createNode(nodeToCreate);

		}
	})

}

/**
	 * Touch the previous nodes so that they don't get erased in this build
*/
const touchAllNodes = async ({ getNodes, touchNode }) => {

	let nodes = getNodes();
	let count = 0;
	await asyncForEach(nodes, async (node) => {
		//only touch the Agility nodes that are NOT sitemap nodes
		const nodeType = node.internal.type.toLowerCase();
		if (nodeType.indexOf("agility") != -1
			&& nodeType.indexOf("agilitySitemapNode") === -1) {
			await touchNode({ nodeId: node.id });
			count++;
		}
	});

	logSuccess(`Touched ${count} nodes`);

}

/**
 * Create a page for Gatsby to render based on a sitemap node
 * @param {*} pagePath
 * @param {*} sitemapNode
 * @param {*} isHomePage
 * @returns
 */
const createAgilityPage = async ({ createPage, createRedirect, pagePath, sitemapNode, isHomePage, pageTemplate, languageCode, isPreview, debug }) => {


	//create a redirect for a link node...
	if (sitemapNode.redirect && sitemapNode.redirect.url) {

		await createRedirect({
			fromPath: pagePath,
			toPath: sitemapNode.redirect.url,
			isPermanent: true,
			redirectInBrowser: true
		});

		return
	}

	//create a regular page
	let createPageArgs = {
		path: pagePath,
		component: pageTemplate,
		context: {
			pageID: sitemapNode.pageID,
			contentID: sitemapNode.contentID || -1,
			languageCode: languageCode,
			title: sitemapNode.title,
			isPreview: isPreview
		}
	}

	//tell gatsby to create the page!
	createPage(createPageArgs);

	if (debug) {
		logDebug(JSON.stringify(createPageArgs));
	}

}

//i.e. `{ '12': { ..pageObject } }`
let dynamicPageNodes = {};

//i.e. `{ '/posts/posts-dynamic': { '15':'/posts/some-postitle', '16':'/posts/someother-post'  } }`
let dynamicPagePreviewRedirects = {};

const createServerDynamicPageItemPreviewRedirect = async ({ createPage, sitemapNode, createRedirect, languageCode, syncClient }) => {

	//TODO: Make this work with mult-language sites
	let page = null;

	//if we don't have this dynamic page node yet, get it, and create a dummy page for it (to handle client-side redirects)
	if (!dynamicPageNodes[sitemapNode.pageID]) {

		//get the dynamic page node so we can figure out what the dynamic page's name is
		page = await syncClient.store.getPage({
			pageID: sitemapNode.pageID,
			languageCode: languageCode
		});

		//save this for later
		dynamicPageNodes[sitemapNode.pageID] = page;

	} else {
		//get from memory
		page = dynamicPageNodes[sitemapNode.pageID];
		previewDummyPageCreated = true;
	}

	//i.e. `/posts/some-post-title`
	const pagePath = sitemapNode.path;

	//strip the dynamic formula path -> `/posts`
	const parentPath = pagePath.substring(0, pagePath.lastIndexOf('/'));

	//i.e. `posts-dynamic`
	const dynamicNodeSlug = page.name;

	//i.e. `/posts/posts-dynamic`
	const dynamicPageNodePath = `${parentPath}/${dynamicNodeSlug}`;

	//build the preview url -> i.e. `/posts/posts-dynamic?ContentID=12`
	const previewUrl = `${dynamicPageNodePath}?ContentID=${sitemapNode.contentID}`;

	//redirect `/posts/posts-dynamic?ContentID` -> `/posts/some-post-title`
	await createRedirect({
		fromPath: previewUrl,
		toPath: pagePath,
		isPermanent: false,
		force: true //for netlify
	});


	//HACK: save a list of all our preview redirects so we can create a dummy client-side page to handle each one in `gatsby develop`
	if (!dynamicPagePreviewRedirects[dynamicPageNodePath]) {
		dynamicPagePreviewRedirects[dynamicPageNodePath] = {};
	}
	//i.e. `{ '/posts/posts-dynamic': { '15':'/posts/some-postitle', '16':'/posts/someother-post'  } }`
	dynamicPagePreviewRedirects[dynamicPageNodePath][sitemapNode.contentID] = pagePath;
}


const resolveChannelRefNames = (channels) => {
	return channels.map((c) => {
		return c.referenceName;
	})
}

const createPagesInEachLanguage = async ({ syncClient, languages, channelsRefs, createPage, createRedirect, pageTemplate, isPreview, debug, isMultiLanguage }) => {

	//TODO: handle mulitple channels, just use the first one for now
	let channelName = channelsRefs[0];

	//set flag for default homepage '/' - it will be the first sitemap node in the first language
	let isHomePage = true;

	//loop through each language
	await asyncForEach(languages, async (language) => {

		const languageCode = language.code;

		//get the sitemap
		let sitemap = await syncClient.store.getSitemap({ channelName, languageCode });

		if (sitemap == null) {
			logWarning(`Could not get the sitemap node(s) for channel ${channelName} in language ${languageCode}`)
			return;
		}


		//loop all nodes we returned...
		let pageCount = 0;
		for (let pagePath in sitemap) {
			const sitemapNode = sitemap[pagePath];

			//skip folders
			if (sitemapNode.isFolder) continue;

			if (isHomePage) {
				//create a redirect from sitemapNode.path to /
				const fromPath = resolvePagePath(sitemapNode.path, language, isMultiLanguage);
				await createRedirect({
					fromPath: fromPath,
					toPath: "/",
					isPermanent: true,
					redirectInBrowser: true
				});

				//also need to create the actual '/' root page - if you don't you'll get a 404 on page-data.json requests to '/home'
				await createAgilityPage({ createPage, pagePath: '/', sitemapNode, isHomePage, pageTemplate, languageCode, isPreview, debug });

				logInfo(`Requests to ${fromPath} will redirect to '/'`)
			}

			isHomePage = false; //clear flag, homepage created...
			pagePath = resolvePagePath(pagePath, languageCode);
			await createAgilityPage({ createPage, createRedirect, pagePath, sitemapNode, isHomePage, pageTemplate, languageCode, isPreview, debug });

			//if this is a dynamic page item, create a redirect for preview i.e. `~/posts/posts-dynamic?ContentID=12
			if (sitemapNode.contentID) {
				await createServerDynamicPageItemPreviewRedirect({ sitemapNode, createRedirect, createPage, languageCode, syncClient, pageTemplate })
			}

			pageCount++;
		}

		logSuccess(`${pageCount} pages created from ${channelName} in ${languageCode}`)
	})

}

const createClientRedirectPageForPreviewNode = ({ createPage }) => {
	//HACK - you need to create a dummy client-only page for the redirect to work in gatsby develop...
	//TODO - remove this logic once we have preview link generation working out of the box

	//this should only happen once in a build, per dynamic page node
	for (let node in dynamicPagePreviewRedirects) {

		//need to build a collection of redirects to pass-through
		const redirectDictByContentID = dynamicPagePreviewRedirects[node];

		createPage({
			path: node,
			component: path.resolve('./src/agility/components/DynamicPreviewPage.js'),
			context: {
				redirects: redirectDictByContentID
			}
		})
	}

}

const resolveLanguageCodes = (languages) => {
	return languages.map((l) => {
		return l.code;
	})
}

const resolvePagePath = (path, language, isMultiLanguage) => {
	if (isMultiLanguage) {
		return `/${language.path}${path}`;
	} else {
		return `${path}`;
	}
}
