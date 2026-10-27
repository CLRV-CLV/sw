# 实现及验收清单

## 动手前

- [ ] 明确本次只修改轮廓、位置、周期、幅度、布局中的哪一项。
- [ ] 保留其他已获认可的参数，不顺手重新设计横幅或配色。
- [ ] 检查当前 Git diff 和组件，避免覆盖用户已有修改。
- [ ] 找到真正负责该层的代码，而不是又追加一套指示器。

## CSS 与组件实现

- [ ] 单项按钮本体的所有状态 `background:transparent`、`border:0`、`box-shadow:none`。
- [ ] 仅独立底板着色；没有旧 TabsIndicator 或旧选中背景残留。
- [ ] fill / outline 来自同一个路径，hover灰框不是胶囊、绿色却是斜切。
- [ ] 几何使用真实尺寸，字体加载、窗口缩放、动态增删项后会更新。
- [ ] 首中尾按实际按钮区分，不把非按钮容器计入顺序。
- [ ] 中间底板额外宽度作用于静态和动态，而不是只作用于hover。
- [ ] 控制 scoped CSS 优先级；必要时精确限定到应用根节点，避免全站 `!important` 补丁。
- [ ] 清理失效规则与旧DOM，而不是依赖新底板一直遮住它们。
- [ ] DOM顺序、aria-selected、focus和命中区仍然正确。

本项目曾出现两类真实缺陷：

1. `body .ik-mobile-nav` 没压过组件 scoped 样式，导致新底板+旧58px底栏混用。应查浏览器实际computed尺寸，当前底栏覆盖限定到 `body #__nuxt …`。
2. 旧 `.ik-stream-tab[data-state='active']` 绿色背景优先级高于透明基础样式，斜切缺口露出了旧按钮。应删除旧规则并对 active/aria-selected 验证透明背景。

## 浏览器验证

建议视口：360、390、430、1440px；桌面结构大改再加1025、1280、1920px。

- [ ] 手机与桌面分别检查，不以缩小的桌面截图冒充手机验证。
- [ ] `/web`、`/h5` 测量对应子视口，确认布局和导航状态一致。
- [ ] 切换至少“最新”与“热门”，不要只看默认第一项。
- [ ] 检查首、中、尾三种轮廓；需登录的项可先验证hover/focus，或用真实测试账号进入。
- [ ] 同时检查基准帧、峰值帧和中间帧，确认中心不漂移、转角没有闪烁。
- [ ] 检查文字位置不随动画改变，手机“推送”保留向右2px光学校正。
- [ ] 中间底板基准宽度约为命中框宽+12px；端部不加这12px。
- [ ] 绿色峰值与灰色hover没有不需要的裁剪框/阴影矩形。
- [ ] 无文档横向滚动、相邻文字覆盖、底栏挡住最后一条内容。
- [ ] 减少动态模式下选中态清楚，按钮仍可使用。

### 如何确定性采样伪元素动画

不要用随机sleep比较两帧，可能恰好采到相同位置。使用：

```js
const animation = element.getAnimations({ subtree: true })
  .find(a => a.animationName === 'ik-nav-plate-breathe');
animation.pause();
animation.currentTime = 0;   // 基准
// 读取 getComputedStyle(element, '::before')
animation.currentTime = 400; // 800ms周期的峰值
// 再读样式，比较左右inset、宽高、文字位置
animation.play();
```

顶部底板是子元素，不是伪元素，应对 `.ik-tab-highlight` 读样式。不要用缺少 `{subtree:true}` 的查询漏掉伪元素动画。

向外呼吸断言：基准左右inset=0；峰值左右同为负；中心不变。中间项负margin是独立的固定增量，不能误认成中心偏移。

## 自动化命令（仓库根目录）

```sh
npm run test:unit --prefix web
npm run typecheck --prefix web
npm run build:web --prefix server
# 涉及服务端时另跑：
node server/test.mjs
```

有可运行的浏览器/服务时，再执行相应Playwright用例。例如：

```sh
cd web
npx playwright test tests/e2e/mobile-nav.spec.ts
```

浏览器依赖或沙箱网络不允许下载时，如实说明未完成浏览器核验，不能把单元检查当成视觉核验。临时截图、浏览器包和测试用户数据不要写入Git。

## 完成时

- [ ] 检查 `git diff --check`。
- [ ] 简述实际改变的参数，不泛称“已完美复刻”。
- [ ] 说明测试通过范围，真实平台/设备未验证的部分要区分。
- [ ] 新的明确设计决定写回此Skill的对应章节，**替换过时的确认值**，不要在规范里无限叠加互相矛盾的历史。
