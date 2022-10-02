const Apify = require("apify");
const urlParse = require("url-parse");

const { makeUrlFull, getIdFromUrl, checkMaxItemsInput, buildStartUrl } = require("./utils");

const { log } = Apify.utils;

Apify.main(async () => {
    const input = (await Apify.getInput()) || {};
    const {
        country,
        maxConcurrency,
        position,
        location,
        startUrls,
        extendOutputFunction,
        proxyConfiguration = {
            useApifyProxy: false,
        },
        saveOnlyUniqueItems = true,
    } = input;

    let { maxItems } = input;
    maxItems = checkMaxItemsInput(maxItems);
    // COUNTER OF ITEMS TO SAVE
    let itemsCounter = 0;
    let currentPageNumber = 1;

    // EXTENDED FUNCTION FROM INPUT
    let extendOutputFunctionValid;
    if (extendOutputFunction) {
        try {
            extendOutputFunctionValid = eval(extendOutputFunction);
        } catch (e) {
            throw new Error(`extendOutputFunction is not a valid JavaScript! Error: ${e}`);
        }
        if (typeof extendOutputFunctionValid !== "function") {
            throw new Error("extendOutputFunction is not a function! Please fix it or use just default output!");
        }
    }

    const requestQueue = await Apify.openRequestQueue();

    const url = new URL("https://uk.indeed.com/jobs?l=cambridge&radius=0&vjk=895b6073ffb7f44c");
    const towns = require("./towns.js").allTowns;
    for (town of towns) {
        url.searchParams.set("l", town);
        const nextRequest = {
            url: url.toString(),
            userData: {
                label: "LIST",
            },
        };
        await requestQueue.addRequest(nextRequest);
    }

    const sdkProxyConfiguration = await Apify.createProxyConfiguration(proxyConfiguration);
    // You must use proxy on the platform
    if (Apify.getEnv().isAtHome && !sdkProxyConfiguration) {
        throw "You must use Apify Proxy or custom proxies to run this scraper on the platform!";
    }

    log.info("Starting crawler...");
    const crawler = new Apify.CheerioCrawler({
        requestQueue,
        useSessionPool: true,
        sessionPoolOptions: {
            maxPoolSize: 50,
            sessionOptions: {
                maxUsageCount: 50,
            },
        },
        maxConcurrency,
        maxRequestRetries: 5, // a lot of 403 blocks at the beginning of the run
        proxyConfiguration: sdkProxyConfiguration,
        handlePageFunction: async ({ $, request, session, response }) => {
            log.info(`Label(Page type): ${request.userData.label} || URL: ${request.url}`);

            if (![200, 404].includes(response.statusCode)) {
                session.retire();
                request.retryCount--;
            }

            switch (request.userData.label) {
                case "LIST":
                    const noResultsFlag = $(".no_results").length > 0;

                    if (noResultsFlag) {
                        log.info("URL doesn't have results.");
                        return;
                    }

                    // Indeed is very "Anti-scraping". So they even change their counter. Sometimes it's like this:
                    let totalItems = parseInt($(".jobsearch-JobCountAndSortPane-jobCount").text().replace(" jobs", "").replace(",", ""));
                    if (!totalItems) {
                        // Sometimes it's like this:
                        totalItems = parseInt($(".searchCount-a11y-contrast-color").text().replace(" jobs", "").replace(",", "").replace("Page 1 of ", ""));
                    }
                    itemsCounter += totalItems;
                    await Apify.pushData({ url: request.url, items: totalItems });
                    const url2 = new URL(request.url);
                    log.info(`Total so far: ${itemsCounter}. Found ${totalItems}, for: ${url2.searchParams.get("l")}. `);
                    break;
                default:
                    throw new Error(`Unknown label: ${request.userData.label}`);
            }
        },
    });
    await crawler.run();
    log.info("Done.");
});
