// main.js

// 浏览器无法识别此种路径，只能识别相对路径，比如"/", "./", or "../".
// 需要实现vite的核心功能之一：裸模块替换
import { createApp, h } from "vue";
// 模板html里面会把入口模块以 <script src="/main.js" type="module"></script>这种形如引入

// 这样当前入口模块以及所有的import都是可以利用浏览器解析import发出Http请求
// 请求会在mini-vite服务端进行处理，从而减少打包环节
import App from "./src/App.vue";

createApp(App).mount("#app");
