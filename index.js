// Loader 兼容垫片：cordis-plugin-loader 的入口解析按 "<package>/index.js" 约定
//（不读 package.json main/exports）。真正实现在 ./lib/index.js，这里透明转发。
export * from "./lib/index.js";
