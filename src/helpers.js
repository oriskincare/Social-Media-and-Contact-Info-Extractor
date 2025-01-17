const Apify = require('apify');
const _ = require('underscore');
const domain = require('getdomain');

const { Request } = Apify;

const nih = /\/(post|article|product)/ig;
const isInteresting = (href) => {
  nih.lastIndex = 0;
  return !nih.test(href);
}

async function extractUrlsFromPage(page, selector, sameDomain, urlDomain, filterRegex) {
  /* istanbul ignore next */
  const output = await page.$$eval(selector, linkEls => linkEls
    .map(link => link.href)
    .filter(href => !!href))

  const re = filterRegex && new RegExp(filterRegex, 'ig');
  const filterByRegex = (url) => {
    if (re) {
      re.lastIndex = 0;
      return !re.test(url);
    }
    return true;
  }

  return output.filter(url =>
    (sameDomain ? module.exports.getDomain(url) === urlDomain : true) &&
    filterByRegex(url));
}

function createRequestOptions(sources, userData = {}) {
  return sources
    .map(src => (typeof src === 'string' ? { url: src } : src))
    .filter(({ url }) => {
      try {
        return new URL(url).href;
      } catch (err) {
        return false;
      }
    })
    .map((rqOpts) => {
      const rqOptsWithData = rqOpts;
      rqOptsWithData.userData = { ...rqOpts.userData, ...userData };
      return rqOptsWithData;
    });
}

function createRequests(requestOptions, pseudoUrls) {
  if (!(pseudoUrls && pseudoUrls.length)) {
    return requestOptions.map(opts => new Request(opts));
  }

  const requests = [];
  requestOptions.forEach((opts) => {
    pseudoUrls
      .filter(purl => purl.matches(opts.url))
      .forEach((purl) => {
        const request = purl.createRequest(opts);
        requests.push(request);
      });
  });
  return requests;
}

async function addRequestsToQueueInBatches(requests, requestQueue, batchSize = 5) {
  const queueOperationInfos = [];
  requests.forEach(async (request) => {
    /* eslint-disable no-await-in-loop */
    queueOperationInfos.push(requestQueue.addRequest(request));
    if (queueOperationInfos.length % batchSize === 0) await Promise.all(queueOperationInfos);
    /* eslint-enable no-await-in-loop */
  });
  return Promise.all(queueOperationInfos);
}

const commerceSelectors = {
  shopify: 'script[src*="cdn.shopify.com"]',
  woo: '[class*="woocommerce"]',
  magento: 'script[src*="skin/frontend"]',
  bigcommerce: 'script[src*="bigcommerce.com"]',
  demandware: 'script[src*="demandware.static"]'
};

module.exports = {
  detectCommerce: async (page) => {
    let found = null;
    const platforms = Object.keys(commerceSelectors)
    for (let i=0; i < platforms.length; i++) {
      const selector = commerceSelectors[platforms[i]];
      const el = await page.$(selector);
      if (el) {
        found = platforms[i];
        break;
      }
    }
    return found;
  },

  async getAttribute(element, attr) {
    try {
      const prop = await element.getProperty(attr);
      return (await prop.jsonValue()).trim();
    } catch (e) {
      return null;
    }
  },

  getDomain(url) {
    return domain.get(url);
  },

  crawlFrames: async (page) => {
    const socialHandles = {};
    page.mainFrame().childFrames().forEach(async (item) => {
      const html = await item.content();
      let childSocialHandles = null;
      const childParseData = {};
      try {
        childSocialHandles = Apify.utils.social.parseHandlesFromHtml(html, childParseData);

        ['emails', 'phones', 'phonesUncertain', 'linkedIns', 'twitters', 'instagrams', 'facebooks'].forEach((field) => {
          socialHandles[field] = childSocialHandles[field];
        });
      } catch (e) {
        console.log(e);
      }
    });


    ['emails', 'phones', 'phonesUncertain', 'linkedIns', 'twitters', 'instagrams', 'facebooks'].forEach((field) => {
      socialHandles[field] = _.uniq(socialHandles[field]);
    });

    return new Promise((resolve) => {
      resolve(socialHandles);
    });
  },

  mergeSocial(frames, main) {
    const output = main;

    Object.keys(output).forEach((key) => {
      output[key] = _.uniq(main[key].concat(frames[key]));
    });

    return output;
  },

  enqueueUrls: async (options = {}) => {
    const {
      page,
      requestQueue,
      selector = 'a',
      sameDomain,
      urlDomain,
      depth,
      filterRegex,
      maxRequests,
    } = options;

    let urls = await extractUrlsFromPage(page, selector, sameDomain, urlDomain, filterRegex);
    if (maxRequests) {
      urls = urls.slice(0, maxRequests);
    }

    const requestOptions = createRequestOptions(urls, { depth: depth + 1 });

    const requests = createRequests(requestOptions);
    return addRequestsToQueueInBatches(requests, requestQueue);
  },
};
