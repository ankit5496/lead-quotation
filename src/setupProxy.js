// src/setupProxy.js
// CRA automatically loads this file — no imports needed in index.js
// Proxies /monday-file/* → https://api.monday.com/* to bypass CORS for file uploads

const { createProxyMiddleware } = require("http-proxy-middleware");

module.exports = function (app) {
  app.use(
    "/monday-file",
    createProxyMiddleware({
      target: "https://api.monday.com",
      changeOrigin: true,
      pathRewrite: { "^/monday-file": "" }, // strip /monday-file prefix
      on: {
        proxyReq: (proxyReq) => {
          // Remove origin/referer headers so Monday doesn't reject the request
          proxyReq.removeHeader("origin");
          proxyReq.removeHeader("referer");
        },
      },
    })
  );
};