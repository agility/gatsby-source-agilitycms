var agility = require('@agility/content-fetch')
var path = require('path')

exports.sourceNodes = async ({ actions, createNodeId, createContentDigest }, configOptions) => {
    const { createNode } = actions
    // Create nodes here, generally by downloading data
    // from a remote API.
    
    const aglClient = agility.getApi({
        guid: configOptions.guid,
        apiKey: configOptions.apiKey,
        isPreview: configOptions.isPreview
    })

    const sharedContentReferenceNames = configOptions.sharedContent;
    const languages = configOptions.languages;
    const channels = configOptions.channels;

    // Source Shared Content ------------------------------------------------------------------------------
    const sourceSharedContent = async ({ aglClient, sharedContentReferenceNames, language }) => {
      const languageCode = language.code;
      await asyncForEach(sharedContentReferenceNames, async (refName) => {

        //Source Content from Shared Content in Agility
        var data = await aglClient.getContentList({ referenceName:refName, languageCode: languageCode }); 

        if(!data || !data.items) {
          logWarning(`Could not find ${refName} (${languageCode}) in the API. Skipping...`)
          return; //kickout
        }

        await asyncForEach(data.items, async (ci) => {
            // Hack: `fields` is a reserved name...
            ci.myFields = ci.fields;
            delete ci.fields;

            // Add-in languageCode for this item so we can filter it by lang later
            ci.languageCode = languageCode;

            const nodeContent = JSON.stringify(ci);
            
            const nodeMeta = {
                id: createNodeId(`${refName}-${ci.contentID}-${languageCode}`),
                parent: null,
                children: [],
                internal: {
                    type: `AgilityContent_${ci.properties.definitionName}`,
                    content: nodeContent,
                    contentDigest: createContentDigest(ci + Date.now())
                }
            }
            const node = Object.assign({}, ci, nodeMeta);
          

            await createNode(node);

            logSuccess(`${ci.contentID} - ${refName} (${languageCode}) node created.`)
        })
      }); 
    }

    // Source Sitemap + Pages ---------------------------------------------------------------------------
    const sourceSitemap = async ({ channel, language }) => {
      const channelName = channel.referenceName;
      const languageCode = language.code;
      const languagePath = language.path;

      const sitemapNodes = await aglClient.getSitemapFlat({ channelName: channelName, languageCode: languageCode}); 

      if(!sitemapNodes) {
        logError(`Could not retrieve sitemap for ${channelName} (${languageCode}.`);
        return; //kickout
      }

      // Loop through each sitemapnode in sitemap
      await asyncForEach(Object.values(sitemapNodes), async (sitemapNode) => {

          // Add-in languageCode for this item so we can filter it by lang later
          sitemapNode.languageCode = languageCode;

         
          // Get page for this node
          const page = await aglClient.getPage({ pageID: sitemapNode.pageID, languageCode: languageCode});

          if(!page) {
            logError(`Could not retrieve page ${sitemapNode.pageID} (${languageCode}).`)
            return; //kickout
          }
          
          // Add-in languageCode for this item so we can filter it by lang later
          page.languageCode = languageCode

           // Update the path to include languageCode (if multi-lingual site)
          if(configOptions.languages.length > 1) {
            sitemapNode.path = `/${languagePath}${sitemapNode.path}`;
            page.path = sitemapNode.path;
          }


          // Hack: set re-jig the format of the `zones` property so that is it not a dictionary (GraphQL doesn't like this)
          let pageZones = [];

          Object.keys(page.zones).forEach((zoneName) => {
            const pageZone = {
              name: zoneName,
              modules: Object.values(page.zones[zoneName])
            }
            pageZones.push(pageZone);
          });

          // Overwrite previous zones property
          page.zones = pageZones;

          const nodeContent = JSON.stringify(page);
          const nodeMeta = {
              id: createNodeId(`page-${channelName}-${page.pageID}-${languageCode}`),
              parent: null,
              children: [],
              internal: {
                  type: 'AgilityPage',
                  content: nodeContent,
                  contentDigest: createContentDigest(page)
              }
          }
          const pageNodeToCreate = Object.assign({}, page, nodeMeta);
          await createNode(pageNodeToCreate);

          logSuccess(`Page ${sitemapNode.path} (${languageCode}, ${page.pageID}) node created.`)

          // Create nodes for each Module on this page - so they can be consumed with GraphQL -
          await asyncForEach(page.zones, async (zone) => {
            const modules = zone.modules;
            await asyncForEach(modules, async (mod) => {
              mod.languageCode = languageCode;
              const moduleContent = JSON.stringify(mod);
              const moduleMeta = {
                  id: createNodeId(`${mod.item.properties.referenceName}-${languageCode}`),
                  parent: null,
                  children: [],
                  internal: {
                      type: `AgilityModule_${mod.module}`,
                      content: moduleContent,
                      contentDigest: createContentDigest(mod)
                  }
              }
              const moduleNodeToCreate = Object.assign({}, mod, moduleMeta);
              await createNode(moduleNodeToCreate);
              logSuccess(`Module ${mod.item.properties.referenceName} (${languageCode}, ${mod.module}) from the page ${sitemapNode.path} node created.`)
            })
          })

          // Now create a node for each sitemap entry as well
          const sitemapNodeContent = JSON.stringify(sitemapNode);
          const sitemapNodeMeta = {
              id: createNodeId(`sitemap-${channel}-${sitemapNode.path}-${languageCode}`),
              parent: null,
              children: [],
              internal: {
                  type: 'AgilitySitemapNode',
                  content: sitemapNodeContent,
                  contentDigest: createContentDigest(sitemapNode)
              }
          }
          const sitemapNodeToCreate = Object.assign({}, sitemapNode, sitemapNodeMeta);
          
          await createNode(sitemapNodeToCreate);
          logSuccess(`SitemapNode ${sitemapNode.path} (${languageCode}, ${channelName}) node created.`)
      })
    }
  
    // DO THE WORK ----------------------------------------------------------------------------

    //Loop through each language
    await asyncForEach(languages, async (language) => {

        await sourceSharedContent({ aglClient, sharedContentReferenceNames, language});
        
        //Loop through each channel
        await asyncForEach(channels, async (channel) => {
          await sourceSitemap({ channel, language});
        })
    })
    
    // We're done, return.
    return
}

exports.createPages = async ({ graphql, actions }, configOptions) => {
    const { createPage } = actions;
    const { createRedirect } = actions;

    const aglClient = agility.getApi({
        guid: configOptions.guid,
        apiKey: configOptions.apiKey,
        isPreview: configOptions.isPreview
    })

    const pageTemplate = path.resolve(configOptions.masterPageTemplate);

    const result  = await graphql(`
    query SitemapNodesQuery {
        allAgilitySitemapNode {
          nodes {
            name
            pageID
            path
            title
            menuText
            languageCode
          }
        }
      }      
  `, { limit: 1000 }).then(async (result) => {
    if (result.errors) {
      throw result.errors
    }

    const modules = configOptions.modules;
    const pageTemplates = configOptions.pageTemplates;

    // Create pages loop...
    await asyncForEach(result.data.allAgilitySitemapNode.nodes, async (sitemapNode) => {
        
        const page = await aglClient.getPage({ pageID: sitemapNode.pageID, languageCode: sitemapNode.languageCode })

        let pagePath = sitemapNode.path;

        // If this is a dynamic page, grab the dynamic item and pass-it to the context
        let dynamicPageItem = null;
        if(sitemapNode.contentID)  {
            dynamicPageItem = await aglClient.getContentItem({ contentID: sitemapNode.contentID, languageCode: sitemapNode.languageCode });
        }

        // Do we have this page in other languages? If so, add-in some info for them so they can be found/accessed easily
        sitemapNode.nodesInOtherLanguages = [];
        if(configOptions.languages.length > 1) {
          result.data.allAgilitySitemapNode.nodes.forEach(smn => {
            // If we found a page with the same ID and its NOT this same page
            if(smn.pageID === sitemapNode.pageID && smn.languageCode !== sitemapNode.languageCode) {

              let languageForThisOtherNode = configOptions.languages.find(l => {
                return l.code === smn.languageCode
              })

              sitemapNode.nodesInOtherLanguages.push({
                name: smn.name,
                pageID: smn.pageID,
                path: smn.path,
                menuText: smn.menuText,
                languageName: languageForThisOtherNode.name,
                languageCode: languageForThisOtherNode.code
              });
            }
            return; 
          })
        }

        let createPageArgs = {
            path: pagePath,
            component: pageTemplate,
            context: { 
              sitemapNode: sitemapNode,
              page: page,
              modules: modules,
              pageTemplates: pageTemplates,
              dynamicPageItem: dynamicPageItem,
              languageCode: sitemapNode.languageCode,
              agilityConfig: configOptions
            }
        }

        let languageForThisPage = configOptions.languages.find(lang => {
            return lang.code === sitemapNode.languageCode
        })

        if(!languageForThisPage) {
          logError(`The language for the page ${page.path} with languageCode ${path.languageCode} could not be found.`);
          return; //kickout
        }

        let homePagePath = languageForThisPage.homePagePath;

        if(configOptions.languages.length > 1) {
          homePagePath = `/${languageForThisPage.path}${languageForThisPage.homePagePath}`;
        }

        if(homePagePath && homePagePath === pagePath) {
            
            logInfo(`Found homepage for ${languageForThisPage.code} (${homePagePath}) in sitemap.`)

            if(configOptions.languages.length > 1) {
              createPageArgs.path = `/${languageForThisPage.path}`
            } else {
              createPageArgs.path = `/`
            }

            createPage(createPageArgs);
            logSuccess(`Index Page ${createPageArgs.path} (${sitemapNode.languageCode}) created.`);

            //create a redirect from the actual page to the root page
            createRedirect({ 
              fromPath: pagePath,
              toPath: createPageArgs.path,
              isPermantent: true,
              redirectInBrowser: true
            });

            logSuccess(`Redirect from ${pagePath} to ${createPageArgs.path} created`);

        } else {
          createPage(createPageArgs);
          logSuccess(`Page ${createPageArgs.path} (${sitemapNode.languageCode}) created.`);
        }

    })

    // Create default language path redirect (if required)
    if(configOptions.languages.length > 1) {
      const defaultLanguage = configOptions.languages[0];
      createRedirect({
        fromPath: '/',
        toPath: `/${defaultLanguage.path}`,
        isPermantent: true,
        redirectInBrowser: true
      })
      logSuccess(`Redirect created for default language path from / to ${defaultLanguage.path}`)
    }
  })
}

exports.onCreateNode = args => {
    
}

async function asyncForEach(array, callback) {
  for (let index = 0; index < array.length; index++) {
    await callback(array[index], index, array);
  }
}

function logSuccess(message) {
  message = `AgilityCMS => ${message}`;
  console.log('\x1b[32m%s\x1b[0m', message);
}

function logWarning(message) {
  message = `AgilityCMS => ${message}`;
  console.log('\x1b[33m%s\x1b[0m', message);
}

function logError(message) {
  message = `AgilityCMS => ${message}`;
  console.log('\x1b[31m%s\x1b[0m', message);
}

function logInfo(message) {
  message = `AgilityCMS => ${message}`;
  console.log(message);
}





