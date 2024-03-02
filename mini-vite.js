const Koa = require("koa");
const path = require("path");
const fs = require("fs");
const compilerSfc = require("@vue/compiler-sfc"); // 解析SFC单文件的script部分
const compilerDom = require("@vue/compiler-dom"); // 解析sfc单文件的template部分
const crypto = require("crypto");

const app = new Koa();

const STARTURL = "http://localhost:3000";

// 使用策略模式，优化对不同模块文件的请求处理代码-todo

/** 获取文件最后修改时间 */
const getFileUpdatedDate = (path) => {
  const stats = fs.statSync(path);
  return stats.mtime.toUTCString();
};

/** 协商缓存判断返回304还是200
 *
 * 头字段ifNoneMatch存在 走etag判断逻辑，和源码唯一hash值进行对比
 * 头字段ifModifiedSinceh存在 走etag判断逻辑，将使用ifModifiedSince和源码的最后修改时间对比
 *
 */

const ifUseCache = (ctx, url, ifNoneMatch, ifModifiedSince) => {
  let flag = false;
  // 使用协商缓存
  ctx.set("Cache-Control", "no-cache");
  // 设置过期时间在30000毫秒，也就是30秒后
  //   ctx.set("Expires", new Date(Date.now() + 30000));
  ctx.set("Cache-Control", "max-age=30");
  let filePath = url.includes(".vue") ? url : path.join(__dirname, url);
  if (url === "/") {
    filePath = path.join(__dirname, "./index.html");
  }
  // 获取文件的最后修改时间
  let fileLastModifiedTime = getFileUpdatedDate(filePath);
  console.log(fileLastModifiedTime, "lastTime");
  const buffer = fs.readFileSync(filePath, "utf-8");
  // 计算请求文件的md5值
  const hash = crypto.createHash("md5");
  hash.update(buffer, "utf-8");
  // 得到etag
  const etag = `${hash.digest("hex")}`;
  if (ifNoneMatch === etag) {
    console.log("走缓存逻辑");
    ctx.status = 304;
    ctx.body = "";
    flag = true;
  } else {
    // etag不一致 更新tag值，返回新的资源
    ctx.set("etag", etag);
    flag = false;
  }

  if (!ifNoneMatch && ifModifiedSince === fileLastModifiedTime) {
    console.log("走缓存逻辑");
    ctx.status = 304;
    ctx.body = "";
    flag = true;
  } else {
    // 最后修改时间不一致，更新最后修改时间，返回新的资源
    ctx.set("Last-Modified", fileLastModifiedTime);
    flag = false;
  }
  return flag;
};

app.use((ctx) => {
  const { url, query } = ctx.request;
  // 从请求头字段来读取ifNoneMatch、ifModifiedSince两个字段，用以协商缓存
  const { "if-none-match": ifNoneMatch, "if-modified-since": ifModifiedSince } =
    ctx.request.headers;
  const home = fs.readFileSync("./index.html", "utf-8");
  // 路由首页返回，返回html
  if (url === "/") {
    ctx.type = "text/html";
    ctx.body = home;
  }
  // 解析html里面的其他资源请求，比如js、css
  else if (url.endsWith(".js")) {
    ctx.set("cache-control", "no-cache");
    // 判断是否读取缓存
    const used = ifUseCache(ctx, url, ifNoneMatch, ifModifiedSince);
    if (used) {
      ctx.status = 304;
      ctx.body = null;
      return;
    }
    const filePath = path.join(__dirname, url); // 获取绝对地址
    const file = fs.readFileSync(filePath, "utf-8");
    ctx.type = "application/javascript";
    // ctx.body = file
    // 裸模快替换成/@modules/包名，浏览器就会发起请求
    ctx.body = rewirteImport(file);
  } else if (url.startsWith("/@modules/")) {
    // 3. 返回裸模快引用的node_modules/包名/package.json.module引用的真实文件
    ctx.type = "application/javascript";
    /** 文件前缀 */
    const filePrefix = path.resolve(
      __dirname,
      "node_modules",
      url.replace("/@modules/", "")
    );
    /** 得到node_modules/包名/package.json 里面的moudule路劲 */
    console.log(filePrefix, "ttt");
    const module = require(filePrefix + "/package.json").module;
    const file = fs.readFileSync(filePrefix + "/" + module, "utf-8");
    // 如果里面还要import XXX 再继续替换
    ctx.body = rewirteImport(file);
    // 依赖使用强缓存
    ctx.set("cache-control", "max-age=31536000,immutable");
  } else if (url.includes(".vue")) {
    // 获得绝对路劲, url.slice(1)去掉第一个'/',并且只取？之前的路劲
    const filePath = path.resolve(__dirname, url.slice(1).split("?")[0]);
    const usedCache = ifUseCache(
      ctx,
      url.slice(1).split("?")[0],
      ifNoneMatch,
      ifModifiedSince
    );
    if (usedCache) {
      ctx.status = 304;
      ctx.body = null;
      return;
    }
    const { descriptor } = compilerSfc.parse(
      fs.readFileSync(filePath, "utf-8")
    );

    console.log("query.type", query);

    //处理script
    if (!query.type) {
      // 获取script
      const scriptContent = descriptor.script.content;
      const script = scriptContent.replace(
        "export default ",
        "const __script = "
      );
      // 返回App.vue解析结果
      ctx.type = "text/javascript";
      ctx.body = `
       //  如果script内容中有import语法，继续进行裸模块替换   
        ${rewirteImport(script)}
        // 如果当前SFC文件，有 style部分 就继续构造import来发送请求 ，服务端拦截对应的请求获取 style 的部分
        ${descriptor.styles.length ? `import "${url}?type=style"` : ""}
        // 发送请求获取template部分，服务端拦截template部分借助@vue/compiler-dom,进行解析，解析的结果是返回一个渲染函数
        import { render as __render } from '${url}?type=template'
        __script.render = __render
        // 最终导入的__script选项对象用于传递给vue的createApp构建一个跟组件
        export default __script
      `;
    } else if (query.type === "template") {
      const templateContent = descriptor.template.content;
      //   在vue中我们使用@vue/compiler-dom 来编译 template
      // 由于我们返回的vue是runtime版本的，是没有编译器的，我们应该将编译好的template返回回去
      const render = compilerDom.compile(templateContent, {
        mode: "module",
      }).code;
      ctx.type = "application/javascript";
      //   控制台network查看它返回的渲染函数
      ctx.body = rewirteImport(render);
    } else if (query.type === "style") {
      // Vite对style的处理比较特殊，处于热更新模块中，由于我们没有实现热更新，咱们这儿就模拟实现一下 updateStyle用于热更新style
      const styleBlock = descriptor.styles[0];
      ctx.type = "application/javascript";
      //   返回用于处理css的js代码，下面css内容以及后续css更新是通过一个叫updateStyle方法来写入样式的，updateStyle方法我们暂时在index.html进行实现
      ctx.body = `
          const css = ${JSON.stringify(styleBlock.content)};
          updateStyle(css)
          export default css;
        `;
    }
  }
});

/**
 * @description: 裸模块替换, import xxx from "xxx" -----> import xxx from "/@modules/xxx"
 * @param {*} content
 * @return {*}
 */
function rewirteImport(content) {
  return content.replace(/ from ['"](.*)['"]/g, (s1, s2) => {
    // s1, 匹配部分， s2: 匹配分组内容
    if (s2.startsWith("./") || s2.startsWith("/") || s2.startsWith("../")) {
      // 相对路劲直接返回
      return s1;
    } else {
      // 完成了替换，但是路径是不对的，需要转换成真正的绝对路径地址
      // 我们在客户端的请求入口统一处理
      return ` from "/@modules/${s2}"`;
    }
  });
}

app.listen(3000, function () {
  console.log("started vite", STARTURL);
});
