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
            useApifyProxy: true,
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
    await buildStartUrl({
        requestQueue,
        position,
        location,
        country,
        startUrls,
        currentPageNumber,
    });

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
        maxRequestRetries: 10, // a lot of 403 blocks at the beginning of the run
        proxyConfiguration: sdkProxyConfiguration,
        handlePageFunction: async ({ $, request, session, response }) => {
            log.info(`Label(Page type): ${request.userData.label} || URL: ${request.url}`);

            if (![200, 404].includes(response.statusCode)) {
                session.retire();
                request.retryCount--;
                throw new Error(`We got blocked by target on ${request.url}`);
            }

            switch (request.userData.label) {
                case "START":
                case "LIST":
                    const noResultsFlag = $(".no_results").length > 0;

                    if (noResultsFlag) {
                        log.info("URL doesn't have result");
                        return;
                    }

                    const urlDomainBase = new URL(request.url).hostname;

                    for (const child of $(".jobsearch-ResultsList").children()) {
                        const jobPostingElement = $(child);

                        const itemId = jobPostingElement.find("a[data-jk]").attr("data-jk");
                        const itemUrl = `https://${urlDomainBase}${$(jobPostingElement.find("a[data-jk]")).attr("href")}`;

                        let result = {
                            positionName: jobPostingElement.find(".jobTitle").text().trim(),
                            salary: jobPostingElement.find(".salary-snippet-container").text().trim() || null,
                            company: jobPostingElement.find(".companyName").text().trim() || null,
                            // TODO: Remove postcode from location
                            location: jobPostingElement.find(".companyLocation").text().trim() || null,
                            url: itemUrl,
                            id: itemId,
                            scrapedAt: new Date().toISOString(),
                        };

                        if (extendOutputFunction) {
                            try {
                                const userResult = await extendOutputFunctionValid($);
                                result = Object.assign(result, userResult);
                            } catch (e) {
                                log.info("Error in the extendedOutputFunction run", e);
                            }
                        }

                        if (result.positionName) {
                            // sometimes there are random <li> items with empty data for all of them . We just skip them.
                            await Apify.pushData(result);
                        }
                    }

                    itemsCounter += 1;

                    let totalItems = parseInt($(".jobsearch-JobCountAndSortPane-jobCount").text().replace(" jobs", "").replace(",", ""));

                    // To get the next page we just go from 0 to maxItemsOnSite. Since Indeed only returns 10 at a time, we increment by ten.
                    var regex = /start=(\d+)/gm; // match start=N , where N is any any number, e.g. start=124124
                    var matches = regex.exec(request.url);
                    try {
                        const currentJobsIndex = parseInt(matches[1]); // matches[1] would be '124124' from above
                        const nextPageUrl = request.url.replace(matches[1], String(currentJobsIndex + 10));
                        const nextRequest = {
                            url: nextPageUrl,
                            userData: {
                                label: "LIST",
                            },
                        };
                        await requestQueue.addRequest(nextRequest);
                    } catch (e) {
                        console.error(e);
                    }

                    break;
                default:
                    throw new Error(`Unknown label: ${request.userData.label}`);
            }
        },
    });
    await crawler.run();
    log.info("Done.");
});
