/**
 * dsh-miliastra — DSH 插件 · Client half
 *
 * 一个侧边栏入口（注册到官方槽位 `sidebar.footer.action`）+ 一个**三栏**状态浮层面板。
 * 面板数据全部走 Host 半边的同源路由 `/miliastra/*`（唯一合法通道）。
 *
 * 契约（2026-09-23 取证自本机 dsh 0.1.5-rc.1）：
 *   · `sidebar.footer.action` = kind `list` / scope `root`，owner props 只有 `{ wide: boolean }`
 *   · 注册写法与官方 `dsh-client-ui-cordis` 的 `CordisPanel` 一致（它是该槽位的真实占用者）
 *   · 锚点：`{ left: rect.left, bottom: innerHeight - rect.top + 8 }`，面板自身 `position: fixed` 向上展开
 *   · 点外关闭用 primitives 的 `useDismissOnOutsidePointer`，**不要自己写 document 监听**
 *
 * 视觉：**粉蓝主调**（浅蓝 ↔ 粉红渐变），结构参考蛋仔面板（dsh-eggy）——
 *       三栏网格 `.body{grid-template-columns:repeat(3,…)}` + `.col` 各自独立滚动 +
 *       sec 卡片 / kv 网格 / dot 状态点 / 渐变主按钮 / 自定义滚动条。
 *       入口图标是内联 PNG（像素画，`image-rendering: pixelated` 保持锐利）。
 *
 * 三栏分工：① 关卡（在哪张图）② 代码（改了什么、备份、部署）③ 日志（跑了什么）。
 *
 * 四条纪律（都是实测踩出来的）：
 *   ① **声明了才敢访问**：`exports.inject = ['slots']`。cordis 的服务代理受限，
 *      不声明就读 `ctx.slots` 会抛 `cannot get property "slots" without inject`，
 *      **并让整条 loader entry 失败**（症状：宿主报 failed to apply，页面上一条我们的日志都没有）。
 *   ② **绝不 throw**：Client 半边抛错会让整个 Web 壳启动失败。所有入口（**包括诊断日志**）都包 try/catch。
 *   ③ **信封有三层**，别少剥一层：`body{ok,data:{name,ok,data:<业务返回体>}}`。
 *   ④ **主题令牌一律带 fallback**：令牌是运行时注入的，缺了不该变成一片透明或纯黑。
 */
(function () {
  // 这几条日志是**刻意的**：client 半边的失败默认是全静默的（没入口、没报错），
  // 排障时最贵的就是"到底卡在哪一步"。刷新一次页面就能从控制台区分：
  //   ① 一条都没有 → bundle 根本没被执行（宿主侧的组装问题）
  //   ② 有「factory 已执行」没有「apply」→ 模块系统没 materialize 我们
  //   ③ 有「apply」没有「入口已注册」→ 槽位声明没到达（壳没渲染该槽位）
  if (typeof window === 'undefined') return;
  if (!window.__ModuleLoader__ || typeof window.__ModuleLoader__.load !== 'function') {
    console.warn('[dsh-miliastra] window.__ModuleLoader__ 不可用 —— client bundle 无法注册 factory。'
      + '若这条出现了，说明本脚本的执行时机早于模块系统就绪。');
    return;
  }

  window.__ModuleLoader__.load({
    id: 'dsh-miliastra',
    factory: function (require) {
      var module = { exports: {} };
      var exports = module.exports;

      var PLUGIN = 'dsh-miliastra';
      var PREFIX = '/miliastra';
      var STYLE_ID = 'dsh-miliastra-style';
      /** 入口图标：内联 data URI，零依赖、换图不用改路由（源图见 lib/assets/icon.png）。 */
      var ICON_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADYAAABACAYAAABRPoQBAAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAAyNpVFh0WE1MOmNvbS5hZG9iZS54bXAAAAAAADw/eHBhY2tldCBiZWdpbj0i77u/IiBpZD0iVzVNME1wQ2VoaUh6cmVTek5UY3prYzlkIj8+IDx4OnhtcG1ldGEgeG1sbnM6eD0iYWRvYmU6bnM6bWV0YS8iIHg6eG1wdGs9IkFkb2JlIFhNUCBDb3JlIDUuNi1jMTQ4IDc5LjE2NDAzNiwgMjAxOS8wOC8xMy0wMTowNjo1NyAgICAgICAgIj4gPHJkZjpSREYgeG1sbnM6cmRmPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5LzAyLzIyLXJkZi1zeW50YXgtbnMjIj4gPHJkZjpEZXNjcmlwdGlvbiByZGY6YWJvdXQ9IiIgeG1sbnM6eG1wPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvIiB4bWxuczp4bXBNTT0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL21tLyIgeG1sbnM6c3RSZWY9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9zVHlwZS9SZXNvdXJjZVJlZiMiIHhtcDpDcmVhdG9yVG9vbD0iQWRvYmUgUGhvdG9zaG9wIDIxLjAgKFdpbmRvd3MpIiB4bXBNTTpJbnN0YW5jZUlEPSJ4bXAuaWlkOjM4OEU0QkQ2RjQzOTExRjA4RTUwQzVGRjVGM0E2REU0IiB4bXBNTTpEb2N1bWVudElEPSJ4bXAuZGlkOjM4OEU0QkQ3RjQzOTExRjA4RTUwQzVGRjVGM0E2REU0Ij4gPHhtcE1NOkRlcml2ZWRGcm9tIHN0UmVmOmluc3RhbmNlSUQ9InhtcC5paWQ6Mzg4RTRCRDRGNDM5MTFGMDhFNTBDNUZGNUYzQTZERTQiIHN0UmVmOmRvY3VtZW50SUQ9InhtcC5kaWQ6Mzg4RTRCRDVGNDM5MTFGMDhFNTBDNUZGNUYzQTZERTQiLz4gPC9yZGY6RGVzY3JpcHRpb24+IDwvcmRmOlJERj4gPC94OnhtcG1ldGE+IDw/eHBhY2tldCBlbmQ9InIiPz6pMgwaAAAV9UlEQVR42sxbCZRlVXXdb/rTe3+eqnqgujq9gLbbRk10ZRmWLAgkLuckS8QIEREnGgVRjEpEs1BBE8SBSIuRiMYBh2gGHEgYlKWJYhTsbrGhhZ6qu+rXr6o/vfenN2Tf+96vHqiW6qZb8te6/T+v3nDP3efss8+5DwXH/3mA4zQOFzHD+/Zn3r8ffoBXvP59K3hM49A5dnA8F0/DRz+ei1RF0eLASv5Mu/wnqSqo1xslaCoymTy63SE0jbYp/spB34bv+0c+0z3ZhinHcc09HGu2WNlqQVFSbhBggUhtdjpAIo2bPvlT5AtlpLN5NBsLzuUXT+527KZ2yPUJjsc4zv5/gxiR0jUoG00FZSuuI62qcmUC3wMcotLvIl9cjVI5ieEQ8NxhKgiC9dIaRTl0FZN9PtsPAvfpNkys+H/FEUx8LAhSWQP48VobQULD2lwGKh3zetuBkiojpuvYtc/GFRcV4Xn9xRvcmLRQVFT5ey7wU5ud9iP8uYvjnKfTMBEkZ0BR88Uc3SzBy7K6NCygYQrjqZCMQYkXoRJFQkgnDxYfYBGtXNJAVg0Nc33fzPXUSTvwLQ/KSUHuWGLsYY7Tb/7cThRLVTRbbSiHuFcwuqFqhJOnof7cNJRLT+M5AYav3BAuBGNS6fkYu2sKc87Q3uzatZOB3LIQU1VN0w0jMK0SkRpDkDVheEkIszxOVFgljBQ//N6CNCSXT9PIOGKVSR6rY09MhaeHa6kyJLNEkJeaOVud7Pi+5SsnFjllObFlmvk1/37XLyrFUjn14584cDkxTQuWvqES3nLoBtB1Bc97jgXXXsBXr9qAbmsBycJKZgUV49Us9KGP8r3TWOgO7au7nVo3CHbz0nM5vJONWBRbQb5YniCN8wKjRzw8GIZ60P+WWi7CoYtz8mT32DiJpQql78NjahDXewmVi6OgwPjUVM/kFZMcueiZJ90VxdRn7E4jf9/9e1EdW41nnEo3NDQyXvDboeakBWoP/mCe1O9h45sewLBTx7Ytm+D22jDcEnRXgd1z0e576AbyfjM4+nKdOMNEbGmaEaTMvHQ/dxhAPj+Kqyc4sjwcHFwSnjfkhbQLqZTFAwYMawV8tcaFITAcXlylMlGR9VTYvh8w1jTGmncyY0wqjI/d+nC1XFmZcjo95isNVqYgJ91pz5PVfRJEeIuALqYwdiwrv3iME4TdXuDESeqKJtOAr8XgOfPYdwdJsDeLNWvXQRv4qN61H/POYPBmpz2IYu1ZT0V66Usjpeqqamw0rWK5WJogwyXRdQZS89Vm9knDjFhCsqIwaJE06J71+gGi4UbuqCMeTwjk5SLwJKSyGbhGAq2uB5ea0uLxGA2uiOcel8JbHmLC0AeTqezEp27bGSuWSrED++s0KKBMKqM+uw+XX7xannjrV+dQqhRQn65L42LJEubq+/C+q56JXrclPTGZyuDvbt7GvLcSC/N1sqSKs84sYra2gDP/oCDvE9cVuUAIY3Z2AKw4EbSvP5nZgv2EK4kFF6EViynwOYme00K3Y0ZJWYFFAdm1VY7m4uW9TusJ6+eSUATyZm4V3bSOvtsTjiz+meZ4/EQp/yMNEzfdKFb80gvK2+Jxc8P37ntconXf/XW6VRL1uRbcQRcXvejdaNs+XnT5R1Es5/Bn53HRByXc98UrUJue41wHSJgZohTDYNjngmgS+S/f8SvJmD/80SOYn5/Fy/90ExynKZTHxhORv5aDmOJ5Qxh0H0MXBCZihIreEuxmMXO7UIMhzJiHdNxjLjKgMTclYimkEgMiqNM9rYhEDqambncAPaajXE1yoU6RhBNBesKMWsowqTRicWvNm99xZ6U6NoF4IsvJSEKROm/0+avLLudUhnjxC6dgpGZ55Jlwejp27z1Ad+zjjZsvQ8LKYM9AQb/Xh66GkivOckfjYrXpse1mg/f0j7cuPCbDQqVBvZDNrUAmW0WfyVPkr8VUJUSs4qNYMFkg092IDmKupHLFd+XxPnVguWRBT5nYM60ctiDSikBIrnBE+Tg42YaJBwi1nY8ZYUx8/+6djAkVxcpKJGM0yt5KKvNw5nN5slznOAtMfg22I0kD/vkrl0hDUllWmv0mtn2fiNP2JBOx54mF8UTZgn3UGM1GamR0ZSTETmaMiSVGs3lA5qYeJY9wHV+oBLJhpyVQ8qEnYuFKDEI1ogR9kaYoci2ZrzB0MKSiiDQx2dCXasMwDGlMbaaFxvy0w5OFjNot09gJjLOlfPvXUfdJSqDrPr6D4nclmW6nLEcGro68GeDqNxIRw0f3v22GGhVGj9mIbFf5wySJRsOX7hpDp69RSlFX0qjHHtsnPX3TGZuIVA3v2vwsOHZjOwlqo0gnJ9UVhTRMmpaMZqfTJEWLIGd6CULExDIstD2Zx9r8TtCw+ZaHgIZRXEAT8Micp6BDIrH7KuIxP+pSRfoydAgaN40IpWOdr7ucbtehht3je96af/3J/1ar1TLn56E2O4/znrFO/vHajzyEdHYc+/f/HDNtH2+/3oSqqGjaLBqZnG+8jLRPJNvTe9Ed6kgmV4OClkjtldevWzchteOePTXM1/eNnjkZJeXHl1FB38uxVuT95XS79BApVWci3ZgpFMuV8ZWoZBNhJOvUeTyDZEf3YtC7rjTYJXq205Kr7wwVUjlFseOC6igS/cqinyvK4X7vukMZa+lMWUivhK4n1jBAzX7PxtFcUmjNeMLcQLYqB4thqAnsk/2+rfM6d6kYu9dMZya+9T8/q4yPj5miPlKIhOg2uTTi1/t2od3q4+f/toC+I+qPMlTfxmT776EHHbhKSorXntMhohm8+/q/IVHm8el/KdEdVWTirjRkZnZGsqy4t2DZsbG8dM90xsL8XM1+2yXr9kR5dKmP98nbdp5SLFbMTseRBzLZ8LrNr127ZM9EILaJ1hXGV69BJW3g8emGVOJDsbJc/nxlnAqiz8nNMZ8NEfc70II2NH6rNMxQfU6PMdVphx0qMbgoVtyVt0+ZhkQYs6HWDImPBmcr0kDTEihqZjZXXU8yIQPHDrfIHfAeOZ4/jkwuxSOm9ArTUsnYZV43PunYCxZJ6DDknkD3cU5KFIc79k2xQKTL5GMYMkkHusn5upi0b4JOo3wtxchNjhqpcoKmZcLrUV7F+rjwBTPwlDj2FZ9NEuFJd1JOOUPMzc/JtLHz0Uck7Ys0oFKV3PCpByXrBkcQ9ejY7l178egjLqam9vL6cHEMar0tX9wpWDb15osmD+tTCsN+yRWYmN67q4rxsZQwSujCIS8e8qGDLkfvoNZTvRYVBg1TY4s5XZCErABExcwUwXIOakKTCMZ0X+YzIXxFXhSTCnNaVIxykRXmtnSmIisJzzuyxcCUOPQxPb0AoV0FwwqXdmVVkEDSTPG5K56AnBKRh2YYsa1WtrD+03f/CKWxcdI5Swrbxfe2bJffydJqKMMG9G1vospooB+kD64vJ+w05pAujeHKb/6ULpNGr09DOAGtXcOgH2Dbw2OwO8ADP3uALtSjW9vS8NWrV9MT9AiFJ7ZcXC60FAARkKNz9+zZG5FNiNxZZz2PXFC3r77sObVut7VbD1fN9/peT+339qO2f0quvDuwMSRarqfKhOsOWlDdDuOtyBVOwDKSoegLQsPE7oqZL/M5LP1prnR25rNuq0XUXaoMFa32AI2FKekJBmNJXDMySDDuEW2ukF+VsDpXo3aDuEa4sIhPcU6325OyLl/IIhY3mXAC2e16Qoxd9dJzZACvHluFdGEcf/mhe2Ty/fo1fyxX+FUfuBMFCt2XnOaC3oa+H00hWlYjlWDAB5ieq6NB9X7H7V+napnBt7/1JXR7lFms5Si88Ia3f4csOsaYayyiLibc77Wk4hfuGovF8Pzn/7789qSk82ReFOedvv4M6Zbbtz3IeQWyAunKFCQZqhb1ZimGVFVOcdgfyNFpNmmgSZdxyIAhYsJg3SwglmFFZsUlN8ePUNBDwWTCSBFzdCOH9Nxpt9FqzS2eFzP6lFNz8sldZyFSI6IxpMn4FCgJBMVCiv6J66pRbPmLrmh3ZiOUA4noYOBy9EfKXJLHNkVTJzZseG7MMOL8Y082YUqlkrzxf3z4ZXLGfqBRTRThO1x1O4UdbaHYgaJoH9ArBHriloJSRKM0SYYkEyFe4EL0D+663LHl/ZJFz3/La5hW+oeoKiHZUnjDlXdKJLv2gkTxoYcel7Hcac/Jfua55/0Jf9fx1tetlUZfcOlXkUxV8IsHd3IR62FBzGpBX7pFTbE7GCyumFASum5wwvpiEPtBONQopba7/dD3eYIoSzodm6iQIOw2dKcNIzIhbBLTzbS+dGM1avyKfw2tx2vq8qxBrympach5CCQ9P3TVkarp9TpRNEp9w2Q9Bbs960RNV0keGwPP17dve2A/f5cPdaxYwsTF198PK53F3P030tfjEs0gMkhQsaWFLvjua65Ho9GEValKtuo6Xagsk0/5ws3Iiv2xeByizXP+5usk1Ld95F3IUXUcqM3LCafNJJptB9d89FI4Tu+wvTVh/qsv/RpMs4Jdu/fTDeuLf8kXJ+R8Pv8PL+ZidJwgcE8VXKSHJgRu4HvbI5HZjcJlgj6b1BNpGMm0rKOEf4/qMgGXYFvixFV2GEMttGhYQCoXsCq5nGhfQYunoQ97i+Qgur/odCUZMM2gQGkkcMhlTOkNnXYzIlpFyi+xSOLZgg1FN0zQvxijj+h08b5O156fiRK0e6TyOPuIUmCWwjgpUBLULMWvMsB0w4fF9GeR+l27hbf97afQItEYuTxyaRNFIiRaOOdPTRH/FfjOpZ/A9FQN772gKm/6zXxeyq6/+OsbGZhx3H79VSjSuFbbRosGj0roz36lhmK5xLKpJxHbf2BOatdstiJlWSxuMT92cPstLxOLYDNsTiW5uL+t/Tb6bBVlRXv+QDVwu0lRooiOkks6HmguWbMFjzfukxg8rmCWrkQ8YYp8FjeQJLULDo5rSenCYl8NghBEPgqiAKXLLSy0JFK60Jj8ESdBQI3L38IjVLq+R/aTLCg2tgOXCznjkICEaFaHA2dUvrjL3x9T5CSEiz7jVa9+E9JWVopj4SI9yggrk8aV77sa6XSaZNGRFO9y4t7cLOovPBfebJ2CmbkpV8b2bxzALK+98aVF+m8Hd1NxiIU6Z4q1WSKGz3/47Shn0+gPB1hoOnjHdf+IDkWmroWJ2g8OqhzhTcyHlajMWbLg1H973yCUoLpmIEsXyqQz6CzU5P5WN+pYQWg2j9rQC+MosWIV/1ML2UpsWaZ1Jm0VRU2wpb7Yr6kybiRyIl7ogg2BnJAMTBOccKvRmBMVaoxrcWSDZ4TQUl627N2WySs/83B19cTK5OZz4hS0wM937JWJceyUtXCa89jy1pej126gUqkglS3iFddsQYLI1lnH6SSHZ69fA5/EcsdpG9CeqWFUdJ01MSFj7eEDBzDD2LmBSA9Had71tpJkNi2jPXBsnWDmDbq89syUlStlKH4zlFBiz1ysQjaXoQqhO3oD+MMunNaCHBlSOAtxdGmsQC5WKcNgbA2VGNxMifExkLnKMrPSMMF6o50aWXdR7RzyMUQo+ks345bV21eOhtSFH/xBtVCdTJ5yyiomToWabh5WUsHVL8nLjHDVK89Dsz7DsiEtJ1kuleX+mdNuwSqU8d5bviy95sbvNsl4Hmnchsdk2xRlfquGS269iOlhGufVw42La5lKShxnr1iBBd/vvmDXrumoLXf2U+5SjZBKmNlSurgKyUwZ7bn9Ulk3baFCdAyCsJdos0wRI5Gywso5bBOj216gptTJlmITDaRwj9e6aDJYpMYgXfsRM0rhLPr7IrcFw7CBz2P8c7JsxibbgW8Ne57u+ce+raQc1rNPpNe8+trvVtPFlUkzV+XEZ3DrFRslEbzxk9tg5caYiGcRdOeh3vUGBP0FsmBSvgUgEBMJPKUwF8XzmH7ezXANojnogCkDt7/nTPmgiz83RWQMnHvJShlP3//sbswSyX+6ZIUUVkJ6pU0DD93758LnOpNnfWMWXe+YkdMP6dlvIgMWaBTMbJXEMEu09nUHPVtkczRn966hWkg2RO926CEn9UJYFwnEBKoCgHaP1cHAwd49uxHE8qiW0mFFLssVSA9IJrkYOV2mjdF+tkHGHVJTisp9nkxZZD7jX62ColrMmMf8HohyyHfdiJuFK27bLx/26cvWoe+06r43LIdVtjEbT2VLr//Er2Gx5mp84QVQWUmXV6yTaj3JpNxiwv34N36ILslFNnB0C++8fZ/sP970unGWQzaPJaCZMczc8xIpiqt/9G26uIqv3fxOKZ4veNuHIHbj7/69SRQEa84toOa59nta7WN6D0RfVJnAL2nfGqdZWyneZqNNU1Ejc9Qt2uq0ZidbVCLoJ5OyLcAJC72nygr3oMpfpLagQ7Fx4PAGDfNenDJpEO2ZDXthO82VVbEGQ9xLaMC5HhK8aUEoEFU95vdAlMPJQ9VZXst0Mug7RnBEI5LkoqlGYmtcV9e/5sxJZFNxqo+8dEUzYaDR6eG6L/5nWHfdcq08fv7mG6iC+jKekpzkRzMZ5Oi2s0wXDRr3kXZPbtbo8RhEc+0tQhAj3MARJdCpqRRaNPqtjQZ6QSDeWD39mFkxoIjsd9tbj5YvaCirCVt1+lGXVz3Yeh+152O6KpEUSlx0kwyf6BxSYVdJMBnRTqPS6Byy+C7zmCD+HMubHO+7h7pQVZTjflt0qQR9xpOhHNO1xU1AgYpwIYcTE0Tygde+kLHWx4WXf0jmtS/d8gFJHhdc/kH0RJ/SNOXEE04HcSGnhsODPc1DNshy4lUkGpYVifzgs5e9j6Yf5TWjZX/CtrUf6kZOopBJSbQG0ZalF8VOnEPluULFSySCw4KlGyXjoM06kPkt1RbXiZc2uSh0RVsJNySXvY92XC87S4MYU0Ndwa7HHmH+0rDi1NPlhGdqNSblHgSqAyJy4RUflq/YfmdsHFUaN+DvIScrXs50Dt6OdIn1Arub+v0abU4t1s4D6cjC+089llcljtswozdEjLGUyuQkIpodvpKUppwK4t1RfPTc/nDXgtxhwwQRTc1SQA9oWJOIEBVHCXsUu0bJlDXC9sO2i4JgyXrrZHx2JFU12EJB9K1iKdj+m53Brx77TfAZTuG2WIIE2AuaXTvI5XJB9FaqNDKlqrMcgRyKImYbMKZq6tKLqz/VxdeP376wn2dlC4svX4pjGhV9Rqr3xfc3ZJHoBMG2o2zcuU+i4N3fmWEUCrh3UxGVagnrGxS9VOzbz1uPWDxsn/Zdf6n3N84+lq3W38k7wUu1DIxyGTEK38CjBlFYKa9ahXhkWHD0zfKnjMRJjTHLsoLfPPpo0LXtYM+ePcH09HRw5KdQKIgY2/F0TfK4Y6zTH6JJ0Ts9fQCGEUM2H75z7w56mJ+bO/L/Z/mdf5TjOH+aZFFJUcMpURNUibaRRt9Dqol2uy3+JpLq2Ml4pehkILaXE07atj18slQnzn26EPs/AQYAzifPQCoY/10AAAAASUVORK5CYII=';
      console.log('[dsh-miliastra] factory 已执行（bundle 被模块系统 materialize）');

      function safeRequire(name) {
        try { return require(name); } catch (e) { console.warn('[' + PLUGIN + '] require("' + name + '") 失败：', e); return null; }
      }

      var React = safeRequire('react');
      var primitives = safeRequire('@deepseek-ai/dsh-client-ui-primitives');

      /* ------------------------------------------------------------------ 样式
       * 粉蓝主调：浅蓝 #7dd3fc ↔ 粉红 #f9a8d4。
       * 三栏网格参考蛋仔面板（dsh-eggy 的 .eggy-body / .eggy-col）。
       * 凡用主题令牌一律写 fallback —— 实测令牌是运行时注入的，缺了不该变成透明或纯黑。
       * ------------------------------------------------------------------ */
      var CSS = [
        // —— 入口 ——
        '.' + PLUGIN + '-root{position:relative;display:flex;align-items:center;}',
        '.' + PLUGIN + '-btn{display:flex;align-items:center;gap:8px;width:100%;border:0;cursor:pointer;',
        'background:transparent;color:var(--dsw-alias-label-primary,#e8f2ff);font:inherit;font-size:13px;',
        'padding:6px 10px;border-radius:10px;white-space:nowrap;transition:background .15s,box-shadow .15s;}',
        '.' + PLUGIN + '-btn:hover{background:linear-gradient(135deg,rgba(125,211,252,.18),rgba(249,168,212,.18));',
        'box-shadow:0 0 0 1px rgba(125,211,252,.30) inset;}',
        '.' + PLUGIN + '-rail{justify-content:center;padding:0;width:36px;height:36px;}',
        '.' + PLUGIN + '-mark{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;',
        'width:22px;height:24px;filter:drop-shadow(0 0 6px rgba(125,211,252,.45));}',
        '.' + PLUGIN + '-mark img{height:24px;width:auto;display:block;image-rendering:pixelated;}',
        '.' + PLUGIN + '-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',

        // —— 面板（三栏 + 头部固定，主体自己滚）——
        '.' + PLUGIN + '-panel{position:fixed;z-index:60;width:min(880px,94vw);max-width:94vw;',
        'height:min(600px,82vh);display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box;padding:0;',
        'border-radius:14px;font-size:12.5px;line-height:1.6;',
        'background:linear-gradient(180deg,#101a2c,#0b1220 62%);',
        'color:var(--dsw-alias-label-primary,#e8f2ff);',
        'border:1px solid rgba(125,211,252,.22);',
        'box-shadow:0 20px 54px rgba(0,0,0,.60),0 0 0 1px rgba(125,211,252,.06) inset;}',

        // —— 头部 ——
        '.' + PLUGIN + '-head{display:flex;align-items:center;gap:9px;padding:10px 13px;cursor:move;user-select:none;',
        'border-bottom:1px solid rgba(125,211,252,.16);',
        'background:linear-gradient(180deg,rgba(125,211,252,.12),transparent);}',
        // 头部里的按钮/输入仍是普通光标（不然「刷新」看起来像能拖）
        '.' + PLUGIN + '-head button,.' + PLUGIN + '-head input{cursor:pointer;user-select:auto;}',
        // 拖起来的时候别选中文字（不然会拉出一片蓝色选区）
        '.' + PLUGIN + '-dragging{user-select:none;}',
        '.' + PLUGIN + '-head .' + PLUGIN + '-mark{width:20px;height:22px;}',
        '.' + PLUGIN + '-head .' + PLUGIN + '-mark img{height:22px;}',
        '.' + PLUGIN + '-title{font-weight:700;letter-spacing:.4px;font-size:13.5px;',
        'background:linear-gradient(90deg,#a5d8ff,#f9a8d4);-webkit-background-clip:text;background-clip:text;color:transparent;}',
        '.' + PLUGIN + '-badge{font-size:10.5px;padding:1px 7px;border-radius:999px;',
        'border:1px solid rgba(249,168,212,.32);color:#ffd6ec;background:rgba(249,168,212,.12);}',
        '.' + PLUGIN + '-spacer{flex:1;}',
        '.' + PLUGIN + '-x{border:0;background:transparent;cursor:pointer;color:#8fa6c4;font-size:15px;',
        'line-height:1;padding:3px 7px;border-radius:8px;}',
        '.' + PLUGIN + '-x:hover{background:rgba(125,211,252,.14);color:#e8f2ff;}',

        // —— 主体：三栏，每栏自己滚 ——
        // 视图模式（会话区全宽 tab）：宽屏下自动分栏，别把两栏挤在一条窄列里
        '.' + PLUGIN + '-inline{overflow:auto;}',
        '.' + PLUGIN + '-inline .' + PLUGIN + '-body{grid-template-columns:repeat(auto-fit,minmax(320px,1fr));max-height:none;}',
        // 浮层里的页面切换（六等分平铺：初级功能 / 高级功能 / 模拟器 / 预制效果 / 像素画 / 网格计算）
        '.' + PLUGIN + '-viewtabs{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:6px;padding:8px 13px 0;}',
        /* ★ 面板可拉大（2026-09-30 作者要求）：右下角可拖宽高。⚠️ 客户端半边需重新构建 + F5；**未做视觉验证**。
         * ★ 2026-10-01：尺寸**回到原样**（880×600；作者原话「还是改回原来的大小其他不变」），
         *   但**多了一个"拖拉"**：按住头部可以**把面板挪到任意位置**（双击头部回原位），位置也记住。
         *   —— 拖的是位置（`left/top`），拉的是尺寸（CSS `resize`，右下角），两件事互不干扰。 */
        '.' + PLUGIN + '-panel{resize:both;overflow:auto;min-width:420px;min-height:340px;max-width:96vw;max-height:96vh;}',
        // 「常驻」按钮：亮起来 = 点外面不会关（作者要的"一直展示在旁边"）
        '.' + PLUGIN + '-pin{font-size:11.5px;padding:3px 10px;border-radius:8px;cursor:pointer;',
        'border:1px solid rgba(125,211,252,.26);background:transparent;color:var(--dsw-alias-label-secondary,#8fa6c4);}',
        '.' + PLUGIN + '-pin:hover{border-color:#7dd3fc;color:#e2e8f0;}',
        '.' + PLUGIN + '-pin.' + PLUGIN + '-pin-on{background:linear-gradient(135deg,rgba(125,211,252,.28),rgba(249,168,212,.28));',
        'border-color:#7dd3fc;color:#e8f2ff;font-weight:600;}',
        '.' + PLUGIN + '-vtab{padding:5px 10px;border-radius:999px;border:1px solid rgba(125,211,252,.28);',
        'background:transparent;color:var(--dsw-alias-label-secondary,#8fa6c4);font-size:11.5px;cursor:pointer;text-align:center;}',
        '.' + PLUGIN + '-vtab:hover{border-color:#7dd3fc;color:#e2e8f0;}',
        '.' + PLUGIN + '-vtab-on{background:linear-gradient(135deg,rgba(125,211,252,.28),rgba(249,168,212,.28));',
        'border-color:#7dd3fc;color:#e2e8f0;font-weight:600;}',
        '.' + PLUGIN + '-body{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;',
        'padding:11px 13px 13px;flex:1 1 auto;min-height:0;overflow:hidden;align-items:stretch;}',
        /*
         * 单页内容**平铺铺满**：初级=①②、高级=③，不留空洞的第三栏。
         * ⚠️ 必须写在 `-body` **之后**、并带复合选择器：同优先级时后写的赢，
         *    上一版写在了前面 → 被 `repeat(3,…)` 盖掉 → 初级页第三列空着（作者实测指出）。
         */
        '.' + PLUGIN + '-body.' + PLUGIN + '-bodyfill{grid-template-columns:repeat(auto-fit,minmax(340px,1fr));}',
        '.' + PLUGIN + '-col{display:flex;flex-direction:column;gap:10px;min-width:0;min-height:0;',
        'overflow-y:auto;overflow-x:hidden;padding-right:3px;}',
        '.' + PLUGIN + '-col::-webkit-scrollbar{width:6px;}',
        '.' + PLUGIN + '-col::-webkit-scrollbar-thumb{background:rgba(125,211,252,.28);border-radius:6px;}',
        '.' + PLUGIN + '-col-head{font-size:10.5px;font-weight:700;letter-spacing:.6px;',
        'color:#7dd3fc;opacity:.85;padding:0 2px;flex:0 0 auto;}',
        // —— 模拟器左列：**只剩日志一张卡**（画面卡已按作者要求删除，画面去右边试玩页看）——
        // 原来这里有个横排网格（画面 + 日志并排）；画面删了就没有并排可言，规则一并撤掉。
        /*
         * 模拟器 tab = **1:2**（作者要求）：左边 1 份是「读本地 .lua / 试玩日志 / 试玩操作 / 时间线 / 验收单 / 工程（折叠）」，
         * 右边 2 份是**试玩页**（iframe 嵌 `/miliastra/play`，PixiJS WebGL，人真能在里面玩）—— 它也是**画面**唯一的落点。
         * ⚠️ 断点原来是 1000px，而**浮层面板就是 880px 宽** —— 于是浮层里永远命中媒体查询、
         * 1:2 塌成一列：右列高度改由内容决定（iframe 的 min-height），舞台只剩 ~168px 高，
         * 画布就被压成 263×148（作者实测 footer 上写着「画布 263×148（可放 542×168）」）。
         * 现在断点下移到 760px：880px 的浮层保持 1:2（300px 左列 + ~545px 试玩页），
         * 真到很窄（窄浮层/手机）才塌成一列，那时给 iframe 一个像样的 min-height。
         */
        '.' + PLUGIN + '-simgrid{display:grid;grid-template-columns:minmax(300px,1fr) 2fr;gap:10px;padding:11px 13px 13px;',
        'align-items:stretch;flex:1 1 auto;min-height:0;}',
        '@media (max-width:760px){.' + PLUGIN + '-simgrid{grid-template-columns:1fr;}'
        + '.' + PLUGIN + '-playframe{min-height:min(420px,55vh);}}',
        // 左列自己滚、右列不动 —— 否则左列一长，滚下去就把 iframe 推出视野（作者实测「右侧啥都没」）
        '.' + PLUGIN + '-playside{display:flex;flex-direction:column;gap:10px;min-width:0;min-height:0;',
        'overflow-y:auto;overflow-x:hidden;padding-right:3px;}',
        /*
         * ⚠️ **左列的子项一律不许收缩**（`flex:0 0 auto` + `min-height:auto`）。
         * 踩过的坑：左列是固定高度的 flex 列，子项默认 `flex-shrink:1` + `min-height:0`，
         * 内容一超就被**压扁并互相重叠**（作者截图里"按钮/文字叠在一起"就是这个，不是渲染 bug）。
         */
        '.' + PLUGIN + '-playside>*{flex:0 0 auto;min-height:auto;}',
        '.' + PLUGIN + '-playside::-webkit-scrollbar{width:6px;}',
        '.' + PLUGIN + '-playside::-webkit-scrollbar-thumb{background:rgba(125,211,252,.28);border-radius:6px;}',
        '.' + PLUGIN + '-playpane{display:flex;flex-direction:column;gap:8px;min-width:0;min-height:0;}',
        '.' + PLUGIN + '-playhead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:0 0 auto;}',
        '.' + PLUGIN + '-playframe{flex:1 1 auto;width:100%;min-height:240px;border:0;border-radius:10px;',
        'background:#0b1220;box-shadow:0 0 0 1px rgba(125,211,252,.20);}',
        // —— 折叠卡（<details>）：summary 用同一套标题样式 ——
        'details.' + PLUGIN + '-sec>summary{cursor:pointer;list-style:none;}',
        'details.' + PLUGIN + '-sec>summary::-webkit-details-marker{display:none;}',
        'details.' + PLUGIN + '-sec>summary:before{content:"▸ ";opacity:.7;}',
        'details.' + PLUGIN + '-sec[open]>summary:before{content:"▾ ";}',
        // —— 模拟器里的"如实提示"条（如：当前工程是出厂默认，重启后就是这样） ——
        '.' + PLUGIN + '-warn{display:flex;flex-direction:column;gap:7px;padding:9px 11px;border-radius:10px;',
        'border:1px solid rgba(249,168,212,.45);background:rgba(249,168,212,.10);font-size:11.5px;line-height:1.6;}',
        '.' + PLUGIN + '-warn>button{align-self:flex-start;}',
        // —— 面板里「试玩页」要一直看得见：整页不滚，让左列自己滚 ——
        '.' + PLUGIN + '-simbody{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;overflow:hidden;}',
        '.' + PLUGIN + '-simbody .' + PLUGIN + '-body{flex:0 0 auto;overflow:visible;max-height:none;}',
        '.' + PLUGIN + '-simbody .' + PLUGIN + '-col{overflow:visible;max-height:none;}',
        // 会话区全宽视图：整页滚（那里高度足够），并保证 1:2 有下限高度
        '.' + PLUGIN + '-inline .' + PLUGIN + '-simbody{overflow:visible;}',
        '.' + PLUGIN + '-inline .' + PLUGIN + '-simgrid{min-height:min(760px,calc(100vh - 190px));}',
        '.' + PLUGIN + '-inline .' + PLUGIN + '-playside{overflow:visible;}',

        // —— 卡片 ——
        '.' + PLUGIN + '-sec{display:flex;flex-direction:column;gap:5px;padding:9px 11px;border-radius:10px;',
        'border:1px solid rgba(125,211,252,.14);background:rgba(255,255,255,.022);flex:0 0 auto;}',
        '.' + PLUGIN + '-sec-title{display:flex;align-items:center;gap:6px;font-size:11.5px;font-weight:600;',
        'color:#a5d8ff;letter-spacing:.3px;}',
        '.' + PLUGIN + '-hint{font-size:10.5px;font-weight:400;color:var(--dsw-alias-label-secondary,#8fa6c4);}',

        // —— 键值网格 ——
        '.' + PLUGIN + '-kv{display:grid;grid-template-columns:auto 1fr;gap:3px 10px;font-size:12px;}',
        '.' + PLUGIN + '-k{color:var(--dsw-alias-label-secondary,#8fa6c4);white-space:nowrap;}',
        '.' + PLUGIN + '-v{word-break:break-all;color:#e8f2ff;font-family:ui-monospace,Consolas,monospace;font-size:11.5px;}',

        // —— 状态点 ——
        '.' + PLUGIN + '-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px;vertical-align:middle;}',
        '.' + PLUGIN + '-dot.ok{background:#7dd3fc;box-shadow:0 0 7px rgba(125,211,252,.6);}',
        '.' + PLUGIN + '-dot.warn{background:#f9a8d4;box-shadow:0 0 7px rgba(249,168,212,.6);}',
        '.' + PLUGIN + '-dot.err{background:#fb7185;box-shadow:0 0 7px rgba(251,113,133,.6);}',

        // —— 按钮与输入 ——
        '.' + PLUGIN + '-row{display:flex;gap:7px;align-items:center;flex-wrap:wrap;}',
        '.' + PLUGIN + '-act{font:inherit;font-size:12px;padding:5px 11px;border-radius:8px;cursor:pointer;',
        'border:1px solid rgba(125,211,252,.26);background:rgba(125,211,252,.10);color:#e8f2ff;',
        'transition:background .15s,box-shadow .15s;flex:0 0 auto;}',
        '.' + PLUGIN + '-act:hover:not(:disabled){background:rgba(249,168,212,.18);box-shadow:0 0 0 1px rgba(125,211,252,.30) inset;}',
        '.' + PLUGIN + '-act:disabled{opacity:.5;cursor:default;}',
        '.' + PLUGIN + '-primary{border-color:transparent;color:#0d1626;font-weight:600;',
        'background:linear-gradient(135deg,#7dd3fc,#f9a8d4);}',
        '.' + PLUGIN + '-primary:hover:not(:disabled){background:linear-gradient(135deg,#a5e0ff,#ffbde0);',
        'box-shadow:0 4px 14px rgba(125,211,252,.35);}',
        '.' + PLUGIN + '-inp{flex:1 1 auto;min-width:0;box-sizing:border-box;border-radius:8px;padding:5px 9px;',
        'font:inherit;font-size:11.5px;background:rgba(0,0,0,.30);color:#e8f2ff;',
        'border:1px solid rgba(125,211,252,.22);}',
        '.' + PLUGIN + '-inp:focus{outline:none;border-color:rgba(249,168,212,.55);box-shadow:0 0 0 2px rgba(125,211,252,.18);}',
        '.' + PLUGIN + '-inp::placeholder{color:#6c7f9c;}',

        // —— 网格计算（第六页）：预设小按钮 + 网格图 ——
        // 网格图：`width:100%` + `height:auto` ⇒ 盒子比例 = viewBox 比例（1600×1000），
        // 这样「点图取坐标」的线性换算才是准的（见 GridPane 里 onGridClick 的注释）。
        '.' + PLUGIN + '-chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:5px;}',
        '.' + PLUGIN + '-chips .' + PLUGIN + '-act{padding:3px 8px;font-size:11px;}',
        '.' + PLUGIN + '-gridsvg{display:block;width:100%;height:auto;border-radius:10px;cursor:crosshair;',
        'background:rgba(4,10,20,.55);box-shadow:0 0 0 1px rgba(125,211,252,.20);}',
        /*
         * 网格图的**独立滚动盒子**（作者 2026-10-01：「网格图改成可以单独滚轮缩放」）：
         * `overflow:auto` ⇒ 放大后用滚动条平移；`max-height` 给它一个视口上限，不然它会一路把面板撑长。
         * ⚠️ 滚轮是**原生非 passive 监听**（见 GridPane 里那个 effect）—— React 的 `onWheel` 是 passive，
         *   在里面 `preventDefault()` 不生效，面板会跟着一起滚。
         */
        '.' + PLUGIN + '-gridbox{overflow:auto;max-height:min(420px,52vh);border-radius:10px;}',
        '.' + PLUGIN + '-gridbox::-webkit-scrollbar{width:8px;height:8px;}',
        '.' + PLUGIN + '-gridbox::-webkit-scrollbar-thumb{background:rgba(125,211,252,.30);border-radius:8px;}',
        // 拖动平移时的手型（作者 2026-10-01：「放大后我希望能左键按住拖动」）
        '.' + PLUGIN + '-gridsvg:active{cursor:grabbing;}',
        '.' + PLUGIN + '-panning,.' + PLUGIN + '-panning .' + PLUGIN + '-gridsvg{cursor:grabbing;}',
        // 色板上的一个小方块（当前笔刷打勾）
        '.' + PLUGIN + '-swatch{width:24px;height:20px;padding:0;border-radius:6px;cursor:pointer;font-size:11px;line-height:1;',
        'border:1px solid rgba(0,0,0,.45);color:#0b1220;font-weight:700;box-shadow:0 0 0 1px rgba(125,211,252,.25);}',
        '.' + PLUGIN + '-swatch-on{box-shadow:0 0 0 2px #7dd3fc,0 0 8px rgba(125,211,252,.6);}',
        // 结论：**放大**的等宽字（作者要求），比 `-log` 的 10.5px 明显大
        '.' + PLUGIN + '-gridsum{font-size:14px;line-height:1.85;color:#e8f2ff;border-radius:9px;padding:6px 8px;',
        'background:rgba(4,10,20,.42);border:1px solid rgba(125,211,252,.12);',
        'font-family:ui-monospace,Consolas,monospace;word-break:break-all;white-space:pre-wrap;}',

        // —— 胶囊 / 日志 / 提示条 ——
        '.' + PLUGIN + '-pill{display:inline-block;font-size:11px;padding:1px 8px;border-radius:999px;margin:1px 4px 1px 0;',
        'border:1px solid rgba(249,168,212,.34);background:rgba(249,168,212,.12);color:#ffd6ec;',
        'font-family:ui-monospace,Consolas,monospace;}',
        '.' + PLUGIN + '-pill:hover{background:rgba(249,168,212,.22);}',
        '.' + PLUGIN + '-log{margin-top:5px;max-height:52vh;overflow:auto;border-radius:9px;padding:5px 4px;',
        'background:rgba(4,10,20,.42);border:1px solid rgba(125,211,252,.12);',
        'font-family:ui-monospace,Consolas,monospace;font-size:10.5px;white-space:pre-wrap;word-break:break-all;color:#c9dcf5;}',
        '.' + PLUGIN + '-log::-webkit-scrollbar{width:8px;}',
        '.' + PLUGIN + '-log::-webkit-scrollbar-thumb{background:rgba(125,211,252,.30);border-radius:8px;}',

        // —— 截图预览（缩略图网格 + 单张放大）——
        // 原图是 2.5 MB 级的 PNG，一次列十几张直接把页面拖垮；所以面板只加载 Host 生成的小图，
        // 点开才看原图（新标签页）。
        '.' + PLUGIN + '-thumbs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin-top:6px;}',
        '.' + PLUGIN + '-thumb{display:block;border-radius:8px;overflow:hidden;text-decoration:none;',
        'border:1px solid rgba(125,211,252,.20);background:rgba(4,10,20,.42);}',
        '.' + PLUGIN + '-thumb:hover{border-color:rgba(249,168,212,.60);}',
        '.' + PLUGIN + '-thumb img{display:block;width:100%;height:auto;background:#0b1220;}',
        '.' + PLUGIN + '-thumbcap{display:block;font-size:9.5px;padding:2px 5px;color:#9fb6d4;',
        'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:ui-monospace,Consolas,monospace;}',
        '.' + PLUGIN + '-preview{margin-top:6px;border-radius:9px;overflow:hidden;',
        'border:1px solid rgba(125,211,252,.22);background:rgba(4,10,20,.42);}',
        '.' + PLUGIN + '-preview img{display:block;width:100%;height:auto;background:#0b1220;}',
        '.' + PLUGIN + '-previewcap{font-size:10px;padding:3px 7px;color:#9fb6d4;}',

        // —— 日志行（格式化后）——
        '.' + PLUGIN + '-lrow{display:flex;gap:6px;align-items:flex-start;padding:2px 5px;border-radius:6px;',
        'border-left:2px solid transparent;}',
        '.' + PLUGIN + '-lrow:hover{background:rgba(125,211,252,.06);}',
        '.' + PLUGIN + '-lrow.' + PLUGIN + '-lbad{background:rgba(251,113,133,.12);border-left-color:#fb7185;}',
        '.' + PLUGIN + '-lrow.' + PLUGIN + '-lwarn{background:rgba(249,168,212,.09);border-left-color:#f9a8d4;}',
        '.' + PLUGIN + '-ltime{flex:0 0 auto;color:#6c7f9c;font-size:9.5px;padding-top:1px;}',
        '.' + PLUGIN + '-ltag{flex:0 0 auto;font-size:9.5px;padding:0 6px;border-radius:999px;',
        'background:rgba(125,211,252,.16);color:#a5d8ff;border:1px solid rgba(125,211,252,.22);}',
        '.' + PLUGIN + '-lmsg{flex:1 1 auto;min-width:0;}',
        '.' + PLUGIN + '-ldet{flex:1 1 auto;min-width:0;}',
        '.' + PLUGIN + '-ldet>summary{cursor:pointer;color:#a5d8ff;outline:none;}',
        '.' + PLUGIN + '-ldet>summary:hover{color:#ffd6ec;}',
        '.' + PLUGIN + '-lpre{margin:4px 0 2px;padding:5px 7px;border-radius:6px;white-space:pre-wrap;',
        'background:rgba(0,0,0,.34);color:#dbe9fb;font-family:inherit;}',
        // —— 可折叠卡片（高级诊断）——
        '.' + PLUGIN + '-fold-title{display:flex;align-items:center;gap:6px;font-size:11.5px;font-weight:600;',
        'color:#a5d8ff;letter-spacing:.3px;cursor:pointer;user-select:none;}',
        '.' + PLUGIN + '-fold-title:hover{color:#ffd6ec;}',
        '.' + PLUGIN + '-onlyai{font-size:10px;padding:1px 7px;border-radius:999px;margin-left:auto;',
        'background:rgba(249,168,212,.14);border:1px solid rgba(249,168,212,.30);color:#ffd6ec;font-weight:500;}',
        '.' + PLUGIN + '-err{font-size:11.5px;color:#ff9fb0;padding:5px 9px;border-radius:8px;',
        'background:rgba(251,113,133,.10);border:1px solid rgba(251,113,133,.28);}',
        '.' + PLUGIN + '-note{font-size:11.5px;color:#ffd6ec;padding:5px 9px;border-radius:8px;',
        'background:rgba(249,168,212,.10);border:1px solid rgba(249,168,212,.26);}',
      ].join('');

      function injectStyle() {
        try {
          if (document.getElementById(STYLE_ID)) return function () {};
          var el = document.createElement('style');
          el.id = STYLE_ID;
          el.setAttribute('data-plugin', PLUGIN);
          el.textContent = CSS;
          document.head.appendChild(el);
          return function () { try { el.remove(); } catch (e) { /* ignore */ } };
        } catch (e) {
          console.warn('[' + PLUGIN + '] 样式注入失败：', e);
          return function () {};
        }
      }

      /**
       * 剥掉路由信封，拿到**工具的业务返回体**。
       *
       * 信封有三层，少剥一层就会读出一堆 undefined（实测踩过两次）：
       *   HTTP body = { ok, data: { name, ok, data: <业务返回体> } }
       *
       * @param {unknown} j 已解析的响应体
       * @returns {{ok:boolean}} 业务返回体；任何一层不对则回 `{ok:false, error}`
       */
      function unwrapToolResult(j) {
        if (j && j.ok === true && j.data && j.data.ok === true && j.data.data && typeof j.data.data === 'object') {
          return j.data.data;
        }
        var msg = (j && j.data && j.data.error) || (j && j.error) || '调用失败（信封形状不符）';
        return { ok: false, error: String(msg) };
      }
      // 仅用于回归测试（信封层数错一次就够贵了）
      exports.__testUnwrapToolResult = unwrapToolResult;

      /** 调 Host 半边：POST /miliastra/tool {name,args}。绝不 throw，失败回 {ok:false}。 */
      function callTool(name, args) {
        /*
         * ★ **硬超时**（2026-09-30）：实测 Host 对面板同款请求 **0.16 秒**就回了（65 KB），
         *   但界面上出现过"按钮一直显示「处理中…」、没有任何提示"⇒ 调用**从未 settle**（浏览器那一侧）。
         *   加一条 20 秒超时 ⇒ 无论它怎么卡，**界面一定给出可见回执**，不会静默卡死。
         */
        var ctl = (typeof AbortController === "function") ? new AbortController() : null;
        var timer = ctl ? setTimeout(function () { ctl.abort(); }, 20000) : null;
        return fetch(PREFIX + "/tool", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name, args: args || {} }),
          signal: ctl ? ctl.signal : undefined,
        }).then(function (r) { return r.json(); })
          .then(unwrapToolResult)
          .catch(function (e) {
            var aborted = !!(e && (e.name === "AbortError" || /abort/i.test(String(e.message || ""))));
            return {
              ok: false,
              error: aborted
                ? "调用超时：Host 20 秒没回（其它调用正常，只有这次卡住）—— 重开面板或重启 dsh web 后重试。"
                : String((e && e.message) || e),
            };
          })
          .then(function (v) { if (timer) clearTimeout(timer); return v; });
      }
      /* ---------------------------------------------------------------- 小组件 */

      function KVGrid(props) {
        return React.createElement('div', { className: PLUGIN + '-kv' }, props.rows);
      }

      function cell(k, v, key) {
        var empty = v === undefined || v === null || v === '';
        return [
          React.createElement('div', { className: PLUGIN + '-k', key: key + '-k' }, k),
          React.createElement('div', { className: PLUGIN + '-v', key: key + '-v' }, empty ? '—' : v),
        ];
      }

      function sec(title, hint, children, key, dotCls) {
        return React.createElement('div', { className: PLUGIN + '-sec', key: key },
          React.createElement('div', { className: PLUGIN + '-sec-title', key: 't' },
            dotCls ? React.createElement('span', { className: PLUGIN + '-dot ' + dotCls, key: 'd' }) : null,
            title,
            hint ? React.createElement('span', { className: PLUGIN + '-hint', key: 'h' }, hint) : null),
          children);
      }

      /** 品牌图标：内联 PNG（像素画用 pixelated 保持锐利）。 */
      function Icon(props) {
        return React.createElement('span', { className: PLUGIN + '-mark', key: props.k },
          React.createElement('img', { src: ICON_DATA_URI, alt: '', draggable: false }));
      }

      function fmtSize(n) {
        if (typeof n !== 'number' || !isFinite(n)) return '—';
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        return (n / 1024 / 1024).toFixed(2) + ' MB';
      }

      function basename(p) { return String(p || '').split('\\').pop(); }

      /** ISO 时间 → 本地 `MM-DD HH:MM`（截图列表用；解析不了就原样回）。 */
      function hhmm(iso) {
        var d = new Date(iso);
        if (!isFinite(d.getTime())) return String(iso || '');
        var p = function (n) { return String(n).padStart(2, '0'); };
        return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
      }

      /** `pendingRestore` 的哨兵值：表示「用固定名那份备份」（= 最近一次覆盖前的版本）。 */
      var RESTORE_FIXED = '__fixed__';

      /**
       * 把 Host 回传的、**给 AI 看的 Markdown** 转成面板能显示的人话。
       *
       * 踩过两次：`BACKUP_NOTE` 与工具回执里的 `**强调**`，面板不渲染 Markdown
       * → 用户看到的是字面量星号。面板不渲染 Markdown，
       * 所以凡是从 Host 拿来的文本，落 UI 前一律经这里剥掉记号。
       */
      function plain(s) {
        return String(s == null ? '' : s).replace(/\*\*/g, '').replace(/`/g, '');
      }
      /** 备份相关说明的统一文案（面板与工具描述保持同一口径）。注意：面板不渲染 Markdown，别写反引号/星号。 */
      var BACKUP_NOTE = '备份就写在你脚本旁边（_backup 目录），每次两份：固定名「<原名>.bak」（最新）+ 一份带本地时间戳的历史（永不自动删）。'

      /*
       * ---------------- 日志格式化 ----------------
       *
       * 之前是一坨 `logs.join('\n')` 直接塞进 <div>：时间/标签/正文同色同字号，
       * 出错的那一行混在几十行里看不出来，超长行（枚举 dump 那种上万字符）会把整块撑爆。
       *
       * 现在拆成结构化行：时间（暗） + [TAG]（胶囊） + 正文（自动折行）；超长正文折叠成
       * 「点开看全」；疑似异常的行左边加一道红/粉竖线。
       *
       * ⚠️ `bad/warn` 是**关键词启发式**，不是权威级别 —— 地图脚本用 print 打日志时不带级别。
       *    所以只用来「显眼」，不用来「判定」。判据一律以正文为准。
       */
      var BAD_RE = /(错误|失败|异常|崩溃|报错|无法|不能|不存在|未就绪|error|failed|exception|not found)/i;
      var WARN_RE = /(警告|注意|重试|超时|warn|retry|timeout|deprecated)/i;

      function parseLogRecord(rec) {
        var time = String((rec && rec.time) || '');
        var raw = String((rec && rec.message) || '');
        var text = raw;
        var tag = '';
        var m = /^\[([^\]\s]{1,24})\]\s*/.exec(text);
        if (m) { tag = m[1]; text = text.slice(m[0].length); }
        var bad = BAD_RE.test(text);
        return { time: time, tag: tag, text: text, raw: raw, bad: bad, warn: !bad && WARN_RE.test(text) };
      }

      /** 从 Host 返回的记录数组造出「格式化行」。超长正文只截一段（点开才看全，别一次塞进 DOM）。 */
      function toLogRows(records) {
        return (records || []).map(parseLogRecord);
      }

      /*
       * ---------------- 「试玩一结束自动取最新一局」 ----------------
       *
       * 信号只有文件系统。2026-09-23 实测（把事实钉死，别再想当然）：
       *   · **每次试玩 = 一个新的 `.gia` 文件**，文件名里 `HH-MM-SS` 是开局时刻，
       *     文件名里那个数字**不是游戏进程 pid**（实测 `YuanShen.exe` 从 12:39 一直开着，
       *     而文件里的号从 135 逐局涨到 151）—— 它是每局的会话序号。
       *   · 文件的 mtime ≈ 最后一次写入（也就是这一局结束的时刻）。
       *   · `.gia` 里**只有脚本自己 print 的内容**，没有框架级的「开始/结束」记录
       *     （全字段导出确认），所以没有权威标记，只能用文件动静代理。
       *   · `YuanShen.exe` 在跑 **不能** 当作「在试玩」—— 它跨了当天 13:40~18:44 的全部试玩。
       *
       * 于是判据是：
       *   · 出现新文件 / 文件变大  → 这一局在动
       *   · 名字和大小都不动了、且等够 AUTO_SETTLE_MS → 认定这局结束 → 自动取回
       *   · 全程没动静 → 不取（别拿几小时前的旧局面糊用户一脸）
       *
       * 抽成纯函数是为了能回归：定时器不好测，判据好测。
       */
      var AUTO_POLL_MS = 4000;
      var AUTO_SETTLE_MS = 6000;
      /** 打开面板时，如果最新一局是这个时间内写完的，也算「刚玩过」→ 直接取回。 */
      var AUTO_FRESH_MS = 30000;

      /**
       * 一个日志局面「上次写入距今多久」（毫秒）。
       *
       * ⚠️ 踩过：Host 的 `listGia` 返回的字段是 **`mtime`（ISO 字符串）**，不是 `mtimeMs`。
       * 我一开始读 `top.mtimeMs` → 恒为 undefined → age 恒 0 → 「刚玩过」永远为真，
       * 于是打开面板就把**十几小时前的旧局面**自动取回来糊用户一脸。
       * 这个是**真机验证跑出来的**（对着 16 分钟前的局面判了「刚结束」）。
       * 现在两种字段都认；都拿不到就返回 Infinity（当「很旧」），宁可保守不漏。
       */
      function logRecordAgeMs(top, now) {
        if (!top) return Infinity;
        var mt = top.mtimeMs;
        if (!(typeof mt === 'number' && isFinite(mt) && mt > 0)) {
          var parsed = Date.parse(top.mtime);
          mt = isNaN(parsed) ? 0 : parsed;
        }
        if (!(mt > 0)) return Infinity;
        return now - mt;
      }

      /** 试玩状态轮询间隔。开跑信号实测 0.07~0.18 秒就到磁盘，所以 2 秒够灵敏、又不吵。 */
      var PT_POLL_MS = 2000;

      /**
       * 「该不该因为开跑而自动截图」——**纯函数**（定时器不好测，判据好测）。
       *
       * `prev = { seeded, startMs, firedStart }`。
       * 两条刻意的设计：
       *   · **打开面板先建基线**：面板一开就发现「上一局在跑」不该触发自动截图 —— 那不是新开跑；
       *   · **同一局只触发一次**（`firedStart` 记住已经为哪个 startMs 抓过），免得轮询复查时连拍。
       */
      function ptStep(prev, info, opts) {
        var p = prev || { seeded: false, startMs: 0, firedStart: 0 };
        if (!info || info.ok === false) {
          return { next: p, action: 'none', phase: 'unknown', reason: '读不到试玩日志' };
        }
        var startMs = info.startedAtMs || 0;
        if (!p.seeded) {
          return {
            next: { seeded: true, startMs: startMs, firedStart: p.firedStart || 0 },
            action: 'none', phase: info.inPlaytest ? 'running' : 'idle',
            reason: info.inPlaytest ? '面板打开时已在试玩中（不补截）' : '',
          };
        }
        // 跑完的那一瞬 startedAtMs 会变 null → 保留旧 startMs，等下一个真正的新局
        if (!startMs || startMs === p.startMs) {
          return { next: p, action: 'none', phase: info.inPlaytest ? 'running' : 'idle', reason: '' };
        }
        var next = { seeded: true, startMs: startMs, firedStart: p.firedStart };
        if (opts && opts.autoShot && p.firedStart !== startMs) {
          next.firedStart = startMs;
          return {
            next: next, action: 'shot', phase: 'started',
            reason: '检测到开跑 → 约 ' + (opts.delaySec || 0) + ' 秒后自动截图',
          };
        }
        return {
          next: next, action: 'none', phase: 'started',
          reason: '检测到开跑（自动截图没开）',
        };
      }

      function autoFollowStep(prev, top, now, settleMs) {
        var p = prev || { name: '', size: -1, stableSince: 0, fetched: '', activity: false, seen: false };
        if (!top || !top.name) return { next: p, action: 'none', phase: 'idle', reason: '还没有日志文件' };

        var isNew = top.name !== p.name;
        var grew = !isNew && top.size !== p.size;

        if (isNew || grew) {
          var age = logRecordAgeMs(top, now);
          // 首次建立基线时：只有「刚刚才写过」的才算刚玩过，旧局面不算
          var activity = p.seen ? true : age <= AUTO_FRESH_MS;
          return {
            next: { name: top.name, size: top.size, stableSince: now, fetched: p.fetched, activity: activity, seen: true },
            action: 'none',
            phase: isNew ? 'new-session' : 'growing',
            reason: isNew
              ? (p.seen ? '检测到新的一局，正在记录' : '刚结束的一局（' + shortSessionName(top.name) + '）')
              : '这一局还在写（试玩中）',
          };
        }

        if (!p.stableSince) {
          return { next: Object.assign({}, p, { stableSince: now }), action: 'none', phase: 'settling', reason: '等它写完' };
        }
        var waited = now - p.stableSince;
        if (waited < settleMs) {
          return {
            next: p, action: 'none', phase: 'settling',
            reason: '安静 ' + Math.round(waited / 1000) + 's / ' + Math.round(settleMs / 1000) + 's',
          };
        }
        if (!p.activity) return { next: p, action: 'none', phase: 'idle', reason: '没动静（面板打开后还没试玩过）' };
        if (top.size === 0) return { next: p, action: 'none', phase: 'empty', reason: '这一局还没写出内容' };
        var key = top.name + ':' + top.size;
        if (p.fetched === key) return { next: p, action: 'none', phase: 'done', reason: '这一局已经取过了' };
        return {
          next: Object.assign({}, p, { fetched: key }),
          action: 'fetch', phase: 'fetching',
          reason: '试玩结束，自动取回',
        };
      }

      /** `2026-09-23_18-44-57_151_201170108.gia` → `18:44:57`（面板里只留时间，省地方）。 */
      function shortSessionName(name) {
        var s = String(name || '').replace(/\.gia$/i, '');
        var m = /^\d{4}-\d{2}-\d{2}_(\d{2})-(\d{2})-(\d{2})/.exec(s);
        return m ? m[1] + ':' + m[2] + ':' + m[3] : s;
      }

      /** 自动跟新的状态图标（沿用面板那套粉蓝，不用 emoji）。 */
      function autoPhaseMark(phase) {
        if (phase === 'growing' || phase === 'new-session') return '●';
        if (phase === 'settling') return '◌';
        if (phase === 'fetching') return '↓';
        if (phase === 'done') return '✓';
        if (phase === 'empty') return '…';
        return '';
      }

      /** 一条日志行的可视渲染。 */
      function LogRow(row, i) {
        var kids = [];
        if (row.time) kids.push(React.createElement('span', { className: PLUGIN + '-ltime', key: 't' }, row.time));
        if (row.tag) kids.push(React.createElement('span', { className: PLUGIN + '-ltag', key: 'g' }, row.tag));
        if (row.text.length > 400) {
          kids.push(React.createElement('details', { className: PLUGIN + '-ldet', key: 'm' },
            React.createElement('summary', null,
              row.text.slice(0, 160) + ' …（共 ' + row.text.length + ' 字符，点开看全）'),
            React.createElement('pre', { className: PLUGIN + '-lpre' }, row.text)));
        } else {
          kids.push(React.createElement('span', { className: PLUGIN + '-lmsg', key: 'm' }, row.text));
        }
        return React.createElement('div', {
          className: PLUGIN + '-lrow' + (row.bad ? ' ' + PLUGIN + '-lbad' : row.warn ? ' ' + PLUGIN + '-lwarn' : ''),
          key: i,
          title: row.raw,
        }, kids);
      }

      /*
       * 试玩探针说明的兜底文案 —— 只在拿不到 Host `op=list` 的 info 时才用
       * （比如 Host 半边是旧版、或 op=list 失败）。
       * 正路是 Host 给：`lib/probes.mjs` 的 PROBE_INFO / PROBE_OVERVIEW 是唯一口径；
       * 这里复制一份只为「Host 不在线也能看懂」，`client-render-test` 会核对两边不脱节。
       */
      var PROBE_OVERVIEW_FALLBACK = {
        what: '试玩探针 = 一段临时替掉你脚本的小程序，只在试玩那几秒跑一次，把游戏内部的信息打到日志里。',
        why: '有些事光读代码看不出来（某个控件号能不能被创建、某个按键枚举叫什么名），必须让游戏真跑一遍才知道。',
        cost: '要临时覆盖活文件，所以试玩的那一局你的玩法不会跑（会自动先备份，用完可一键还原）。',
        steps: ['选一个试玩探针', '点「部署」（覆盖活文件，先自动备份）', '在编辑器里重新试玩一局', '回来点「收回结论」，然后还原你的脚本'],
      };
      var PROBE_FALLBACK = [
        {
          template: 'ping', label: '探活',
          oneLine: '确认「脚本到底有没有跑起来」',
          what: '只往日志里打几行字：脚本加载了没、OnStart 跑了没、OnUpdate 有没有在跳。',
          when: '试玩完日志里什么都没有时，先跑它。用来分清是「脚本压根没起来」还是「起来了但那段没执行」。',
        },
        {
          template: 'tree', label: '看控件',
          oneLine: '看屏幕上现在挂着哪些客户端控件、画布多大',
          what: '把每个活控件的名字、索引、父子关系、可见性列出来，并读一次画布尺寸。',
          when: '怀疑「控件没建出来 / 建到了错的父级下 / 尺寸不对」时。也能顺手核对画布尺寸是不是你预期的。',
        },
        {
          template: 'instantiate', label: '试钥匙',
          oneLine: '拿一串索引号去试，看哪个真能被脚本创建出来',
          what: '对每个候选号调一次创建接口：成功打 OK，失败是 nil；试出来的控件立刻销毁。',
          when: '准备让脚本动态建控件之前。只有「在模板库里存为模板」的控件才能被创建，画布上摆的实例一律 nil —— 用它查出哪些号真的能用。',
        },
        {
          template: 'api-surface', label: '翻字典',
          oneLine: '把游戏里的枚举和它们的成员列出来（比如某个按键到底叫什么名）',
          what: '枚举各枚举表的全部成员与取值，并实测几个按键枚举能不能取到值。',
          when: '要引用某个枚举 / 按键名，但文档翻不到或不确定写法时 —— 别猜，让它把真名打出来。输出较长，已做分片打印。',
        },
        {
          template: 'api-check', label: '核文档',
          oneLine: '官方文档写的那些接口，真机上到底有没有',
          what: '拿文档抽出来的接口名逐个按名取一次，报「存在 / 取不到」；顺带打印 game.IsTestPlay()（是不是在试玩）与画布尺寸，并实测一次 Tween。',
          when: '想用文档里某个没写过的接口之前先核一遍 —— 文档 ≠ 真机（版本/端/开关都可能不一样）。也可以只为看 game.IsTestPlay() 的值跑它。',
        },
        {
          template: 'perf', label: '量帧率',
          oneLine: '真机上这一局到底卡不卡（帧间隔的中位 / p95 / 最长帧）',
          what: '连续采样每一帧的 dt，每 2 秒打一次中途快照、最后打一次总结：帧数、dt 中位/p95/最大、以及超过 34 / 50 / 100 毫秒的长帧各多少帧。',
          when: '怀疑「界面卡 / 掉帧 / 偶发一顿」时。卡不卡是唯一必须真机量的指标 —— 离线模拟器量的是它自己的循环速度。dt 的单位文档没写死，回执会把两种读法都打出来。',
        },
      ];

      /* ---------------------------------------------------------------- 面板 */

      /*
       * ★ 2026-09-26（作者要求）：**撤掉会话区顶部的三个 tab**（`初级功能 / 高级功能 / 模拟器`）。
       *
       * 曾经的做法是把它们注册进官方槽位 `conversation.view`（与官方「对话 / 轨迹」并列）。
       * 现在的口径是：**插件的 GUI 只有一处入口** —— 侧边栏左下角「千星奇域」点开后的浮层面板；
       * 面板内部自带 `初级功能 / 高级功能 / 模拟器` 三页切换（见 Panel 里的 `panelTab`）。
       * ⇒ 这里不再有任何 `conversation.view` 注册（`VIEW_TABS` 连数据一起删掉）。
       * 回归绊线：`tests/client-render-test.mjs` 断言**没有**注册该槽位 —— 一旦有人加回来就会红。
       */

      function Panel(props) {
        var open = props.open;
        var setOpen = props.setOpen;
        var rootRef = props.rootRef;
        /*
         * ⚠️ 2026-09-26：`inline=true`（会话区全宽视图）那条路**已没有生产入口** ——
         *    顶部三个 tab 撤掉后，Panel 只由侧边栏浮层以 `inline=false` 渲染。
         *    `inline` 分支暂时保留（本地渲染测试还在用），但**别再当它有活调用方**。
         *   · 三页切换在浮层内部：`panelTab` = `'basic'` / `'advanced'` / `'sim'`（见下方切换条）
         *   · `group` 只在历史 `inline` 调用里才传（`'basic'` / `'advanced'` / `'all'`）
         */
        var inline = !!props.inline;
        var group = props.group || 'all';

        var s1 = React.useState(props.__status || null); var status = s1[0]; var setStatus = s1[1];
        /*
         * ★ 插件更新检查（2026-09-30，作者要求；作者已**明确允许联网**）：
         *   打开面板时查一次 GitHub 的公开 tags 接口 —— **只读、无 token、4 秒超时**。
         *   ⚠️ 铁律：**查不到就说"没查到"**，绝不允许显示成"已是最新" ——
         *   本仓反复踩的坑就是把"不知道"说成"没事"（`.gia` 未落盘、`preflight` 全绿都栽在这条）。
         */
        var sUpd = React.useState(null); var update = sUpd[0]; var setUpdate = sUpd[1];
        var cmpVer = function (a, b) {
          var pa = String(a || '').replace(/^v/, '').split('.').map(function (x) { return parseInt(x, 10) || 0; });
          var pb = String(b || '').replace(/^v/, '').split('.').map(function (x) { return parseInt(x, 10) || 0; });
          for (var i = 0; i < 3; i++) { var d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
          return 0;
        };
        /*
         * ★ 版本号来源（2026-09-30 当场查清）：`miliastra_health` 的回执**没有 `version` 字段**
         *   （实测 brief 模式只有 current / luaFiles / gil / logDir / proc）—— 所以面板里那行
         *   "Host v…" 与顶栏 chip **一直渲染不出来**（作者连问两次"我的版本号呢"）。
         *   `miliastra_echo` 明确回 `version`（实测 "0.4.0"）⇒ 面板从这里取；health 里若将来有了就用 health 的。
         */
        /*
         * ★★ 预设表**静态内置**（2026-09-30 作者报"下拉一直停在（正在取清单…）"）：
         *   之前下拉靠 useEffect 去调 miliastra_gen 的 preset:list 才填 —— 那次调用没成功时，
         *   下拉就永远空着（而 Host 侧其实是好的，我用 curl 验过 ok:true,count:13）。
         *   **能力不该依赖一次网络请求才能显示** ⇒ 13 个预设写死在客户端；
         *   真正的参数与交付仍以 Host 的 preset:list 与文档为准（这里只用于"能选"）。
         */
        var PRESETS_UI = [
          ['star-scatter', '星光散射', false], ['snow-fall', '轻雪飘落', false], ['coin-collect', '金币汇聚', false],
          ['chest-collect', '宝箱汇聚', true], ['star-rain', '五角星雨', false], ['petal-fall', '花瓣飘落', false],
          ['ember-rise', '火星上升', false], ['confetti-pop', '彩纸礼花', false], ['peacock-in', '孔雀开屏·收拢', false],
          ['peacock-out', '孔雀开屏·展开', false], ['firefly-drift', '萤火虫漂浮', false], ['bubble-up', '气泡上浮', false],
          ['hit-spark', '命中火花', false],
        ];
        var sVer = React.useState(''); var verEcho = sVer[0]; var setVerEcho = sVer[1];
        React.useEffect(function () {
          callTool('miliastra_echo', { text: 'panel' }).then(function (r) {
            if (r && r.ok && r.version) setVerEcho(String(r.version));
          });
        }, []);
        var verNow = (status && status.version ? String(status.version) : '') || verEcho;
        React.useEffect(function () {
          if (!verNow || typeof fetch !== 'function') return undefined;
          var ctl = typeof AbortController === 'function' ? new AbortController() : null;
          var timer = setTimeout(function () { if (ctl) { try { ctl.abort(); } catch (e) { /* 超时就当"没查到" */ } } }, 4000);
          fetch('https://api.github.com/repos/LoktLin/dsh-miliastra/tags', {
            signal: ctl ? ctl.signal : undefined,
            headers: { accept: 'application/vnd.github+json' },
          })
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function (list) {
              var tag = Array.isArray(list) && list.length ? String((list[0] && list[0].name) || '').replace(/^v/, '') : '';
              if (!tag) throw new Error('返回里没有 tag');
              setUpdate({ latest: tag, cur: verNow, newer: cmpVer(tag, verNow) > 0 });
            })
            .catch(function (e) { setUpdate({ error: String((e && e.message) || e), cur: verNow }); })
            .then(function () { clearTimeout(timer); });
          return function () { clearTimeout(timer); if (ctl) { try { ctl.abort(); } catch (e) { /* 卸载时忽略 */ } } };
        }, [verNow]);
        var s2 = React.useState(false); var busy = s2[0]; var setBusy = s2[1];
        var s3 = React.useState(''); var err = s3[0]; var setErr = s3[1];
        /** 日志（已格式化的行）。`__logs` 仅供本地渲染测试/工具预置样例行。 */
        var s4 = React.useState(props.__logs || []); var logs = s4[0]; var setLogs = s4[1];
        var s5 = React.useState(''); var srcPath = s5[0]; var setSrcPath = s5[1];
        var s6 = React.useState(''); var note = s6[0]; var setNote = s6[1];
        var s7 = React.useState(null); var anchor = s7[0]; var setAnchor = s7[1];
        var s8 = React.useState(null); var mapInfo = s8[0]; var setMapInfo = s8[1];
        var s9 = React.useState(null); var scriptInfo = s9[0]; var setScriptInfo = s9[1];
        var s10 = React.useState(null); var fileInfo = s10[0]; var setFileInfo = s10[1];
        /** 备份清单。`__backups` 仅供本地渲染测试预置（否则「一键还原」那块测不到）。 */
        var s11 = React.useState(props.__backups || null); var backups = s11[0]; var setBackups = s11[1];
        var s12 = React.useState([]); var tags = s12[0]; var setTags = s12[1];
        var s13 = React.useState(''); var tagFilter = s13[0]; var setTagFilter = s13[1];
        /** 待确认的还原目标（备份路径，或 RESTORE_FIXED 哨兵）。`__pendingRestore` 仅供渲染测试。 */
        var s14 = React.useState(props.__pendingRestore || ''); var pendingRestore = s14[0]; var setPendingRestore = s14[1];
        /**
         * 当前选中的活文件名。
         * ⚠️ **一个关卡可以有多个 `.lua`**（不同角色 / 不同模块各挂一个客户端脚本），
         *    所以「当前文件」必须是显式状态，所有 op（体检/备份/比对/部署/还原）都跟着它走。
         */
        var s15 = React.useState(''); var activeFile = s15[0]; var setActiveFile = s15[1];
        /** 选中的关卡；**空串 = 自动跟随**（跟着 `miliastra_health` 判定的「当前关卡」走）。 */
        var s16 = React.useState(''); var activeLevel = s16[0]; var setActiveLevel = s16[1];
        /** 历史局面（`.gia` 文件）；空串 = 最新那局。 */
        var s17 = React.useState([]); var sessions = s17[0]; var setSessions = s17[1];
        var s18 = React.useState(''); var activeSession = s18[0]; var setActiveSession = s18[1];
        /** 试玩探针：选模板 → 部署（**覆盖活文件**，带备份）→ 重新试玩 → 收回结论 → 还原脚本。 */
        var s19 = React.useState('ping'); var probeTemplate = s19[0]; var setProbeTemplate = s19[1];
        var s20 = React.useState('P1'); var probeTag = s20[0]; var setProbeTag = s20[1];
        var s21 = React.useState(null); var probeResult = s21[0]; var setProbeResult = s21[1];
        var s22 = React.useState(false); var pendingProbe = s22[0]; var setPendingProbe = s22[1];
        /** 试玩探针的大白话说明（op=list 从 Host 拿，单一口径；拿不到就用下面的兜底文案）。
         *  `__probeInfo` 仅供本地渲染测试模拟「Host 返回的清单」用（否则「Host 是旧版」那条提示测不到）。 */
        var s23 = React.useState(props.__probeInfo || null); var probeInfo = s23[0]; var setProbeInfo = s23[1];
        /** 部署试玩探针时产生的备份路径 —— 用来「一键还原我的脚本」。
         *  `__probeBackup` 仅供本地渲染测试预置初值（State 从外面设不了，否则「已部署」那段永远测不到）。 */
        var s24 = React.useState(props.__probeBackup || null); var probeBackup = s24[0]; var setProbeBackup = s24[1];
        /** 「高级诊断」折叠区默认**收起** —— 试玩探针主要给 AI 排障用，不该占创作者的视线。 */
        var s25 = React.useState(props.__advOpen === true); var advOpen = s25[0]; var setAdvOpen = s25[1];
        /** 日志过滤：只看疑似异常的行（关键词启发式）。 */
        var s26 = React.useState(false); var onlyBad = s26[0]; var setOnlyBad = s26[1];
        /**
         * 「读界面控件」的结果（高级诊断区）。
         * 这是**静态读取**：直接从地图存档 `.gil` 里读客户端控件谱系（模板索引 / 名字 / 父子），
         * 不用试玩、不用覆盖任何文件。想要**运行时**的控件树就点试玩探针里的「看控件」。
         * `__uiInfo` / `__uiRaw` 仅供渲染测试预置。
         */
        var s29 = React.useState(props.__uiInfo || null); var uiInfo = s29[0]; var setUiInfo = s29[1];
        var s30 = React.useState(false); var uiBusy = s30[0]; var setUiBusy = s30[1];
        var s31 = React.useState(props.__uiRaw === true); var uiRaw = s31[0]; var setUiRaw = s31[1];
        /**
         * 试玩结束**自动取回最新一局**（作者要求）。
         * 默认开。守望 `.gia` 文件：名字或大小一变就说明「试玩在动」，
         * 然后等它安静下来（SETTLE_MS）就自动取回那一局 —— 不用人再点「取日志」。
         * `__autoLog` / `__autoState` 仅供渲染测试预置状态。
         */
        var s27 = React.useState(props.__autoLog !== false); var autoLog = s27[0]; var setAutoLog = s27[1];
        var s28 = React.useState(props.__autoState || null); var autoState = s28[0]; var setAutoState = s28[1];
        /**
         * 浮层面板内部的视图切换（0.1.0）。会话区那三个 tab（`conversation.view`）是**另一处**入口，
         * 两处共用同一份卡片：这里切的是「浮层里先看哪一组」；会话区视图（inline）不用这个状态 —— 那边由 tab 本身决定。
         *
         * ⚠️ 变量名**别再叫 `sNN`**：这里原来是 `var s29`，而上面 `uiInfo` 那个 state 也叫 `s29`
         * （`var` 复用同一个绑定）。当前靠"先读后写"侥幸正确，但只要有人调换两段顺序，
         * `uiInfo` 就会**静默变成** panelTab —— 2026-09-24 被 `tools/lint.mjs` 的 `no-redeclare` 抓到。
         */
        var panelTabState = React.useState(props.group || props.__panelTab || 'basic');
        var panelTab = panelTabState[0]; var setPanelTab = panelTabState[1];
        /** 守望用的游标（不进 state：它每秒都在变，进 state 会引发无意义重渲染）。 */
        var watchRef = React.useRef({ name: '', size: -1, stableSince: 0, fetched: '' });
        var doLogsRef = React.useRef(null);
        var tagFilterRef = React.useRef(tagFilter);

        /** 所有工具调用统一带上「当前关卡」——空串表示让 Host 自动判定。 */
        var lvArg = function () { return activeLevel ? { level: activeLevel } : {}; };

        /**
         * 拉状态。
         * @param {boolean} light 轻量刷新（只拉状态 + 地图），供 15 秒轮询用；
         *                        全量（含活文件体检 / 备份 / 标签 / 历史局面）在打开面板与点「刷新」时走。
         */
        var load = React.useCallback(function (light) {
          setBusy(true); setErr('');
          // all:true —— 面板要列出**全部**关卡供切换（默认只回 12 个，本机实测有 18 个）
          callTool('miliastra_health', { all: true }).then(function (r) {
            if (!r.ok) { setBusy(false); setErr(r.error || '未知错误'); return null; }
            setStatus(r);
            // 截图目录的摘要随状态一起来 —— 打开面板就该看到「图存在哪、有多少」，
            // 而不是点了按钮才第一次知道（作者要求「跟日志一样要提示用户」）
            // 注意保留 lastCapture：15 秒轮询会把 shotInfo 换掉，回执不能跟着没
            if (r.shots) {
              setShotInfo(function (prev) {
                return Object.assign({}, r.shots, { lastCapture: prev && prev.lastCapture ? prev.lastCapture : null });
              });
            }

            // 关卡的「当前」：手动选过就用手动的，否则跟着 Host 判定的当前关卡（= 自动跟随换图）
            var levels = r.levels || [];
            var wanted = activeLevel || (r.current ? r.current.levelId : '');
            var lv = levels.find(function (x) { return x.levelId === wanted; }) || r.current || null;

            // 一个关卡可能有多个活文件 —— 确保 activeFile 是有效的那个；
            // 有效就留着（不打断用户的选择），失效/为空才重新挑（挑列表第一个）。
            var files = (lv && lv.luaFiles) || [];
            var stillThere = !!activeFile && files.some(function (f) { return f.name === activeFile; });
            var pick = stillThere ? activeFile : (files[0] ? files[0].name : '');
            if (pick !== activeFile) {
              setActiveFile(pick);
              setBusy(false);
              return null; // activeFile 变了会重建 load 并重跑，下一趟就会带上正确的 file
            }
            var F = Object.assign({}, lvArg(), pick ? { file: pick } : {});

            return callTool('miliastra_map', Object.assign({ op: 'summary' }, F)).then(function (m) {
              setMapInfo(m && m.ok !== false ? m : null);
              return callTool('miliastra_map', Object.assign({ op: 'script' }, F)).then(function (sc) {
                setScriptInfo(sc && sc.ok !== false ? sc : null);
                if (light) { setBusy(false); return null; }
                return callTool('miliastra_code', Object.assign({ op: 'inspect' }, F)).then(function (fi) {
                  setFileInfo(fi && fi.ok !== false ? fi : null);
                  return callTool('miliastra_code', Object.assign({ op: 'backups' }, F)).then(function (bk) {
                    setBackups(bk && bk.ok !== false ? bk : null);
                    return callTool('miliastra_log', Object.assign({ op: 'tags' }, lvArg())).then(function (tg) {
                      if (tg && tg.ok !== false && tg.tags) setTags(tg.tags);
                      return callTool('miliastra_log', Object.assign({ op: 'sessions', limit: 12 }, lvArg())).then(function (ss) {
                        setSessions(ss && ss.ok !== false && Array.isArray(ss.files) ? ss.files : []);
                        setBusy(false);
                      });
                    });
                  });
                });
              });
            });
          }).catch(function (e) {
            setBusy(false);
            setErr(String((e && e.message) || e));
          });
        }, [activeFile, activeLevel]);

        React.useEffect(function () { if (open) load(false); }, [open, load]);

        /**
         * 试玩探针说明只拉一次（不是状态轮询的一部分）。
         * 面板不硬编码模板清单：模板名 / 大白话说明都由 Host 的 `op=list` 给，
         * 这样加模板不用改 panel，也不会出现「面板写的是旧清单」。
         */
        React.useEffect(function () {
          if ((!open && !inline) || probeInfo) return undefined;
          var alive = true;
          callTool('miliastra_probe', Object.assign({ op: 'list' }, lvArg())).then(function (r) {
            if (!alive || !r || !r.ok) return;
            setProbeInfo({
              templates: r.templates || [],
              info: r.info || [],
              overview: { what: r.whatIsAProbe, why: r.why, cost: r.cost, steps: r.steps || [] },
            });
            if (r.templates && r.templates.length && r.templates.indexOf(probeTemplate) < 0) setProbeTemplate(r.templates[0]);
          }).catch(function () { /* 拿不到就用兜底文案 */ });
          return function () { alive = false; };
        }, [open, probeInfo, probeTemplate, lvArg]);

        React.useEffect(function () {
          if (!open && !inline) return undefined;
          var t = setInterval(function () { load(true); }, 15000);
          return function () { clearInterval(t); };
        }, [open, load]);

        /**
         * 试玩结束 → 自动取回最新一局。
         *
         * 依赖只放 open / autoLog / activeLevel：`lvArg` / `doLogs` / `tagFilter` 每次渲染都是新身份，
         * 放进依赖会让这个 4 秒的定时器每次渲染都被重建（面板每 15 秒轮询一次 → 定时器永远跑不满）。
         * 所以后两者走 ref 读最新值。
         */
        React.useEffect(function () {
          if ((!open && !inline) || !autoLog) return undefined;
          var stopped = false;
          var lastKey = '';

          var tick = function () {
            if (stopped) return;
            callTool('miliastra_log', Object.assign({ op: 'sessions', limit: 5 },
              activeLevel ? { level: activeLevel } : {})).then(function (r) {
              if (stopped || !r || r.ok === false) return;
              var top = (r.files || [])[0] || null;
              var step = autoFollowStep(watchRef.current, top, Date.now(), AUTO_SETTLE_MS);
              watchRef.current = step.next;

              // 只在「状态真的变了」时 setState，否则每 4 秒无意义重渲染一次整个面板
              var key = step.phase + '|' + (top ? top.name : '') + '|' + (top ? top.size : '') + '|' + step.reason;
              if (key !== lastKey) {
                lastKey = key;
                setAutoState({
                  phase: step.phase, reason: step.reason,
                  name: top ? top.name : '', size: top ? top.size : 0,
                });
              }
              if (step.action === 'fetch' && top && top.path) {
                var fn = doLogsRef.current;
                if (typeof fn === 'function') fn(tagFilterRef.current || '', top.path);
              }
            });
          };

          tick();
          var t = setInterval(tick, AUTO_POLL_MS);
          return function () { stopped = true; clearInterval(t); };
        }, [open, autoLog, activeLevel]);

        /**
         * 试玩开跑轮询（0.0.4）。
         *
         * 依赖只放 `open` / `activeLevel` —— 开关与秒数走 ref，否则用户一改秒数
         * 这个 2 秒定时器就被重建一次（面板每 15 秒还会 `load(true)` 重渲染）。
         */
        React.useEffect(function () {
          if (!open && !inline) return undefined;
          var stopped = false;
          var shotTimer = null;

          var tick = function () {
            if (stopped) return;
            callTool('miliastra_playtest', Object.assign({ op: 'status' },
              activeLevel ? { level: activeLevel } : {})).then(function (r) {
              if (stopped || !r) return;
              setPtInfo(r);
              var opt = ptAutoRef.current || { on: false, delay: 3 };
              var step = ptStep(ptRef.current, r, { autoShot: !!opt.on, delaySec: opt.delay });
              ptRef.current = step.next;
              if (step.reason) setPtNote(step.reason);
              if (step.action === 'shot') {
                var delayMs = Math.max(0, Number(opt.delay) || 0) * 1000;
                shotTimer = setTimeout(function () {
                  if (stopped) return;
                  var fire = doCaptureRef.current;
                  if (typeof fire === 'function') fire('game');
                }, delayMs);
              }
            }).catch(function () { /* 轮询失败不打扰用户；状态行会显示上次拿到的值 */ });
          };

          tick();
          var t = setInterval(tick, PT_POLL_MS);
          return function () {
            stopped = true;
            clearInterval(t);
            if (shotTimer) clearTimeout(shotTimer);
          };
        }, [open, activeLevel]);

        // 锚点：面板是触发器的子元素 + position:fixed，向上展开（抄官方 CordisPanel）
        React.useLayoutEffect(function () {
          if (!open) return undefined;
          var place = function () {
            try {
              var rect = rootRef.current && rootRef.current.getBoundingClientRect();
              if (rect) setAnchor({ left: rect.left, bottom: window.innerHeight - rect.top + 8 });
            } catch (e) { /* ignore */ }
          };
          place();
          window.addEventListener('resize', place);
          return function () { window.removeEventListener('resize', place); };
        }, [open, rootRef]);

        /*
         * ★ 2026-10-01（作者：「我希望插件能一直展示在旁边辅助我，我不希望点会输入框就被关掉」）：
         *   `pinned`（常驻）= 点面板外面**不关**。默认开；`useDismissOnOutsidePointer` 是官方 hook，
         *   第二个参数就是**开关**（hook 本身无条件调用 —— 条件调用会违反 react-hooks 规则，lint 拦得住）。
         */
        var pinState = React.useState(function () { return panelPref(PANEL_PIN_KEY, true); });
        var pinned = pinState[0]; var setPinned = pinState[1];
        React.useEffect(function () { panelPrefSet(PANEL_PIN_KEY, pinned); }, [pinned]);

        /*
         * ★ 拖拉（2026-10-01 作者：「然后可以拖拉」）：按住**头部**把面板挪到任意位置，双击头部回到原位。
         *   · 位置存在 `dsh-miliastra:panel-pos`（`{left,top}`），刷新后还在；
         *   · 拖的是**位置**，右下角那个是**拉尺寸**（CSS `resize`，自 0.6.0 就有）—— 两件事互不干扰；
         *   · 拖到屏幕外也要**留下 60px**（否则面板就"找不回来了"，而 × 也跟着出去）。
         */
        var posState = React.useState(function () {
          var v = storeGet(PANEL_POS_KEY);
          if (v && isFinite(Number(v.left)) && isFinite(Number(v.top))) return { left: Number(v.left), top: Number(v.top) };
          return null;
        });
        var dragPos = posState[0]; var setDragPos = posState[1];
        var dragFrom = React.useRef(null);
        var dragOnState = React.useState(false);
        var dragging = dragOnState[0]; var setDragging = dragOnState[1];
        var panelRef = React.useRef(null);
        React.useEffect(function () {
          if (!dragPos) return undefined;
          storeSet(PANEL_POS_KEY, dragPos);
          return undefined;
        }, [dragPos]);
        React.useEffect(function () {
          if (!dragging) return undefined;
          var move = function (e) {
            var d = dragFrom.current;
            if (!d) return;
            var box = panelRef.current && panelRef.current.getBoundingClientRect();
            var w = box ? box.width : 880;
            var left = Math.max(-(w - 60), Math.min(window.innerWidth - 60, e.clientX - d.dx));
            var top = Math.max(0, Math.min(window.innerHeight - 32, e.clientY - d.dy));
            setDragPos({ left: Math.round(left), top: Math.round(top) });
          };
          var up = function () { dragFrom.current = null; setDragging(false); };
          window.addEventListener('mousemove', move);
          window.addEventListener('mouseup', up);
          return function () {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
          };
        }, [dragging]);
        var onHeadDown = function (e) {
          if (inline) return;
          try {
            if (e.button != null && e.button !== 0) return;
            // 点在按钮/输入上不算拖（否则点「刷新」会把面板拽走）
            var t = e.target;
            if (t && typeof t.closest === 'function' && t.closest('button,input,select,textarea,a,label,summary,details')) return;
            var box = panelRef.current && panelRef.current.getBoundingClientRect();
            if (!box) return;
            dragFrom.current = { dx: e.clientX - box.left, dy: e.clientY - box.top };
            setDragging(true);
            e.preventDefault();
          } catch (err) { /* 拖不动不影响面板本身能用 */ }
        };
        var onHeadDouble = function () {
          if (inline) return;
          dragFrom.current = null;
          setDragging(false);
          setDragPos(null);
          storeSet(PANEL_POS_KEY, null);   // 清掉记住的位置 ⇒ 回"贴着侧栏按钮往上展开"
        };

        if (primitives && typeof primitives.useDismissOnOutsidePointer === 'function') {
          try { primitives.useDismissOnOutsidePointer(rootRef, open && !pinned, setOpen); } catch (e) { /* ignore */ }
        }

        /**
         * 取日志。
         * @param {string} [tag]  按标签过滤（空 = 全部）
         * @param {string} [file] 指定某一局（空 = 最新那局）
         */
        var doLogs = function (tag, file) {
          var args = Object.assign({ op: 'tail', limit: 60 }, lvArg());
          if (file) args.file = file;
          if (tag) { args.op = 'grep'; args.tag = tag; }
          setBusy(true); setErr(''); setNote('');
          callTool('miliastra_log', args).then(function (r) {
            setBusy(false);
            if (r.ok) {
              setLogs(toLogRows(r.records));
              if (file) setActiveSession(file);
              var parts = [];
              if (file) parts.push('局 ' + basename(file));
              if (tag) parts.push('标签 ' + tag);
              parts.push((r.records || []).length + ' 条');
              setNote(parts.join(' · '));
            } else setErr(r.error || '读日志失败');
          });
        };

        // 让「自动取回」那个定时器读到最新的回调与过滤条件（见上面 effect 的注释）
        doLogsRef.current = doLogs;
        tagFilterRef.current = tagFilter;

        var doTags = function () {
          setBusy(true); setErr(''); setNote('');
          callTool('miliastra_log', Object.assign({ op: 'tags' }, lvArg())).then(function (r) {
            setBusy(false);
            if (r.ok) { setTags(r.tags || []); setNote('读到 ' + (r.tags || []).length + ' 个标签'); }
            else setErr(r.error || '读标签失败');
          });
        };

        /**
         * 部署试玩探针 —— ⚠️ **它会覆盖选中的活文件**（试玩探针源码替换你的脚本）。
         * 所以固定两步：先 setPendingProbe(true) 弹确认，再点「确认覆盖」才真的执行。
         * Host 侧 `op=deploy` 会先自动备份，所以覆盖后能从「备份」卡片回退。
         */
        var doDeployProbe = function () {
          var tag = (probeTag || 'P1').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'P1';
          setBusy(true); setErr(''); setNote(''); setProbeResult(null); setProbeBackup(null);
          var a = Object.assign({ op: 'deploy', template: probeTemplate, tag: tag }, lvArg());
          if (activeFile) a.file = activeFile;
          callTool('miliastra_probe', a).then(function (r) {
            setBusy(false);
            setPendingProbe(false);
            if (r.ok) {
              // 记住这份备份 = 「第 4 步：还原我的脚本」的凭据
              setProbeBackup(r.backup || null);
              setNote('试玩探针已部署（' + (r.label || probeTemplate) + ' / ' + tag + '）'
                + ' —— 第 2 步：去编辑器「停止试玩 → 重新试玩一局」（先停掉当前那局）');
            } else setErr(r.error || ((r.errors || []).join('；') || '部署试玩探针失败'));
            load(false);
          });
        };

        /** 第 4 步：把试玩探针换回你自己的脚本（用部署时自动生成的那份备份）。 */
        var doRestoreProbe = function () {
          if (!probeBackup) { setErr('没有可用的备份路径 —— 请到「代码」栏的备份清单里手动还原'); return; }
          setBusy(true); setErr(''); setNote('');
          var a = Object.assign({ op: 'restore', backup: probeBackup }, lvArg());
          if (activeFile) a.file = activeFile;
          callTool('miliastra_code', a).then(function (r) {
            setBusy(false);
            if (r.ok) {
              setNote('已还原回你的脚本（' + basename(r.restoredFrom || probeBackup) + '，' + (r.bytes || 0) + ' 字节）'
                + ' —— 记得「停止试玩 → 重新试玩一局」才会生效');
              setProbeBackup(null);
              setProbeResult(null);
            } else setErr(r.error || ((r.errors || []).join('；') || '还原失败'));
            load(false);
          });
        };

        /** 收回试玩探针结论：从最新一局日志里捞该 tag 的输出。 */
        /**
         * 读界面控件（静态，从 `.gil` 读，不改任何文件）。
         *
         * 为什么值得放在面板上：写客户端脚本最缺的两个号就是
         * **容器节点索引**与**控件模板索引** —— 以前要靠人抄、或者写试玩探针去试。
         * `miliastra_map op=clientui` 能把它们直接读出来，**不用试玩、不用覆盖脚本**。
         */
        var doReadUi = function () {
          setUiBusy(true); setErr(''); setNote('');
          callTool('miliastra_map', Object.assign({ op: 'clientui' }, lvArg())).then(function (r) {
            setUiBusy(false);
            if (r && r.ok !== false) {
              setUiInfo(r);
              setNote('读到 ' + (r.count || 0) + ' 条控件记录 · 可创建模板 ' + ((r.likelyTemplates || []).filter(function (x) { return x.name !== '容器节点'; }).length) + ' 个');
            } else {
              setErr((r && r.error) || '读界面控件失败（地图还没存盘？）');
            }
          });
        };

        var doCollectProbe = function () {
          var tag = (probeTag || 'P1').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'P1';
          setBusy(true); setErr(''); setNote('');
          callTool('miliastra_probe', Object.assign({ op: 'collect', tag: tag }, lvArg())).then(function (r) {
            setBusy(false);
            if (r.ok) {
              setProbeResult(r);
              setNote(r.hit ? '收回 ' + r.count + ' 行 [' + tag + ']' : '这一局里没有 [' + tag + '] 的输出');
            } else setErr(r.error || '收回失败');
          });
        };

        var doDeploy = function () {
          if (!srcPath) { setErr('请填本地 .lua 的绝对路径'); return; }
          setBusy(true); setErr(''); setNote('');
          callTool('miliastra_code', Object.assign({ op: 'deploy', source: srcPath }, lvArg(), activeFile ? { file: activeFile } : {})).then(function (r) {
            setBusy(false);
            if (r.ok) setNote('已部署 ' + (r.bytes || 0) + ' 字节 · sha=' + String(r.sha256 || '').slice(0, 12) + ' · 备份' + (r.backup ? '已生成（' + basename(r.backup) + '）' : '无'));
            else setErr(r.error || ((r.errors || []).join('；') || '部署失败'));
            load(false);
          });
        };

        /**
         * 还原。`pendingRestore` 是选中的备份路径，或哨兵 `RESTORE_FIXED` 表示「固定名那份」
         * （`<原名>.bak` = 最近一次覆盖前的版本）—— 不传 backup 给 Host，它自己解析固定名。
         *
         * 失败时把 Host 给的 `nextSteps` 一并显示 —— 光说「失败」等于把问题丢回给用户。
         * 若 Host 报了 `rolledBack`，要明确告诉用户「活文件已经被自动放回原样」。
         */
        var doRestore = function () {
          if (!pendingRestore) return;
          var isFixed = pendingRestore === RESTORE_FIXED;
          setBusy(true); setErr(''); setNote('');
          var args = Object.assign({ op: 'restore' }, lvArg(), activeFile ? { file: activeFile } : {});
          if (!isFixed) args.backup = pendingRestore;   // 固定名那份 = 不传 backup
          callTool('miliastra_code', args).then(function (r) {
            setBusy(false);
            var shown = isFixed ? '固定名备份' : basename(pendingRestore);
            setPendingRestore('');
            if (r.ok) {
              setNote('已还原 ' + (isFixed ? shown : basename(r.restoredFrom || shown))
                + (r.usedFixedBackup ? '（固定名 · 最近一次覆盖前的版本）' : '')
                + ' · ' + (r.bytes || 0) + ' 字节 · sha=' + String(r.sha256 || '').slice(0, 12)
                + (r.safetyBackup ? ' · 还原前那一版已存为 ' + basename(r.safetyBackup) : '')
                + ' —— 记得在编辑器里「停止试玩 → 重新试玩一局」才会生效');
            } else {
              var tips = (r.nextSteps || []).join('　·　');
              setErr((r.error || ((r.errors || []).join('；')) || '还原失败')
                + (r.rolledBack ? '　✅ 已自动回滚，活文件仍是还原前那一版（没坏）' : '')
                + (tips ? '　→ ' + tips : ''));
            }
            load(false);
          });
        };

        /**
         * 截图状态。
         *
         * 作者的要求原话：「做游戏截图希望有这个功能跟日志一样要提示用户，是存到插件运行目录
         * 要提示用户清理」。所以这一块的设计目标**不是「能截到图」**（工具已经把图截出来了），
         * 而是**让用户始终知道东西落在哪、占了多少、以及它不会自己消失**：
         *   · 面板一打开就把目录 / 张数 / 占用摆出来（`status.shots`），不用点按钮才看得到；
         *   · 清理走「先规划、再确认」两步，判据在 Host（纯函数 `planClean`，有单测）；
         *   · 回执里的 pid / title 也显示出来 —— 「截到的是不是那个窗口」必须能自证。
         */
        var s34 = React.useState(props.__shot || null); var shotInfo = s34[0]; var setShotInfo = s34[1];
        var s35 = React.useState(false); var shotBusy = s35[0]; var setShotBusy = s35[1];
        var s36 = React.useState(props.__cleanPlan || null); var cleanPlan = s36[0]; var setCleanPlan = s36[1];
        var s37 = React.useState(false); var showShotFiles = s37[0]; var setShowShotFiles = s37[1];
        var s38 = React.useState(''); var shotTarget = s38[0]; var setShotTarget = s38[1];

        /*
         * 试玩开跑侦测（0.0.4）。
         *
         * 为什么要它：`.gia` **不是实时的** —— 实测「21:46:58 结束、21:47:07 才落盘」，
         * 局在跑的时候磁盘上根本没有那个文件。所以「游戏开跑 N 秒后的画面」只能靠
         * `output_log.txt` 里的实时标记（实测延迟 0.07~0.18 秒）来触发。
         * 自动截图**默认关**：磁盘是用户的，没人点过就不该自己往里写文件。
         */
        var s39 = React.useState(props.__pt || null); var ptInfo = s39[0]; var setPtInfo = s39[1];
        var s40 = React.useState(props.__autoShot === true); var autoShot = s40[0]; var setAutoShot = s40[1];
        var s41 = React.useState(3); var autoShotDelay = s41[0]; var setAutoShotDelay = s41[1];
        var s42 = React.useState(''); var ptNote = s42[0]; var setPtNote = s42[1];
        var ptRef = React.useRef({ seeded: false, startMs: 0, firedStart: 0 });
        var ptAutoRef = React.useRef({ on: props.__autoShot === true, delay: 3 });
        var doCaptureRef = React.useRef(null);
        React.useEffect(function () {
          ptAutoRef.current = { on: autoShot, delay: autoShotDelay };
        }, [autoShot, autoShotDelay]);

        /* ------------------------------------------------ 截图（画面取证） */

        /**
         * 截一张。
         *
         * ⚠️ 面板**不做**「截完自动删」或「自动清理」——作者明确要求「要提示用户清理」，
         * 磁盘是用户的，删除不可恢复，所以清理永远是人显式点的。
         */
        var doCapture = function (target) {
          if (shotBusy) return;
          setShotBusy(true); setErr(''); setNote('');
          setCleanPlan(null);
          callTool('miliastra_shot', { op: 'capture', target: target || 'game' })
            .then(function (r) {
              setShotBusy(false);
              if (r && r.ok) {
                setShotInfo({
                  dir: r.dir, count: (r.shots || {}).count, totalBytes: (r.shots || {}).totalBytes,
                  totalText: (r.shots || {}).totalText, newest: { name: r.file, sizeText: r.sizeText, mtime: null },
                  files: [], lastCapture: r,
                });
                setNote('已截图 ' + r.file + '（' + r.sizeText + '，' + r.width + '×' + r.height
                  + '，截到的是「' + (r.title || r.process) + '」pid=' + r.pid + '）'
                  + (r.suspect ? '　⚠️ ' + (r.warning || '这张图可能不可信') : ''));
                doShotList();
              } else {
                setErr(((r && r.error) || '截图失败')
                  + (r && (r.runningWindows || []).length ? '　→ 当前可截窗口：' + r.runningWindows.join(' ') : ''));
              }
            });
        };
        // 试玩轮询的效应比这里早定义，所以走 ref 取最新那份 doCapture（同 doLogsRef 的做法）
        doCaptureRef.current = doCapture;

        /** 只列目录（不截图）。保留上一次截图的回执 —— 它不该因为刷新列表就消失。 */
        var doShotList = function () {          callTool('miliastra_shot', { op: 'list' }).then(function (r) {
            if (r && r.ok !== false) {
              setShotInfo(function (prev) {
                return Object.assign({}, r, { lastCapture: prev && prev.lastCapture ? prev.lastCapture : null });
              });
            }
          });
        };

        /** 第一步：让 Host 算「会删哪些」（dryRun，绝不删）。 */
        var doShotCleanPlan = function () {
          if (shotBusy) return;
          setShotBusy(true); setErr(''); setNote('');
          callTool('miliastra_shot', { op: 'clean', keepLast: 5, olderThanDays: 7 }).then(function (r) {
            setShotBusy(false);
            if (r && r.ok !== false) {
              setCleanPlan(r);
              setNote(r.note || '');
            } else setErr((r && r.error) || '清理规划失败');
          });
        };

        /** 第二步：确认真删（双钥匙：dryRun:false + confirm:true）。 */
        var doShotCleanConfirm = function () {
          if (shotBusy) return;
          setShotBusy(true); setErr(''); setNote('');
          callTool('miliastra_shot', { op: 'clean', keepLast: 5, olderThanDays: 7, dryRun: false, confirm: true })
            .then(function (r) {
              setShotBusy(false);
              setCleanPlan(null);
              if (r && r.ok) {
                setNote('已删除 ' + r.removedCount + ' 张（' + r.bytesText + '），'
                  + '现在剩 ' + ((r.after || {}).count || 0) + ' 张 / ' + ((r.after || {}).totalText || '0 B'));
              } else {
                setErr((r && r.error) || ((r && (r.failed || []).length) ? '部分删除失败' : '清理失败'));
              }
              doShotList();
            });
        };

        if (!open && !inline) return null;

        // 「当前关卡」= 手动选的（若有）否则 Host 判定的那个 —— 面板所有展示都跟着它
        var cur = (function () {
          if (!status) return null;
          if (!activeLevel) return status.current;
          return (status.levels || []).find(function (x) { return x.levelId === activeLevel; }) || status.current;
        })();
        var lua = cur && cur.luaFiles && cur.luaFiles.length ? cur.luaFiles[0] : null;
        var anchorStyle = anchor ? { left: anchor.left, bottom: anchor.bottom } : { left: 12, bottom: 60 };
        /*
         * 用户拖过之后就用他放的位置（`left/top`），否则仍贴着侧栏按钮**向上展开**（`left/bottom`）。
         * 注意：`bottom` 与 `top` **不能同时给** —— 同时给会把高度拉成"从 top 到 bottom"，那就不受 600px 约束了。
         */
        if (dragPos) {
          anchorStyle = { left: dragPos.left, top: dragPos.top, bottom: 'auto' };
        }
        // 视图模式：铺满会话区（不吸在侧边栏按钮上方、不带圆角与投影、自己滚动）
        var panelStyle = inline
          ? { position: 'relative', left: 'auto', bottom: 'auto', width: '100%', maxWidth: 'none',
              minHeight: '100%', maxHeight: 'none', borderRadius: 0, boxShadow: 'none', zIndex: 'auto' }
          : anchorStyle;
        var col = function (title, kids, key) {
          return React.createElement('div', { className: PLUGIN + '-col', key: key },
            React.createElement('div', { className: PLUGIN + '-col-head', key: 'h' }, title), kids);
        };

        /* ---------------- 第 1 栏：关卡 ---------------- */

        var lvRows = [];
        if (status) {
          lvRows = lvRows.concat(cell('本机存档', status.localLow, 'a'));
          lvRows = lvRows.concat(cell('关卡数', String(status.levelCount), 'b'));
          if (cur) {
            lvRows = lvRows.concat(cell('当前关卡', cur.brand + ' / ' + cur.levelId, 'c'));
            lvRows = lvRows.concat(cell('账号', String(cur.accountId), 'd'));
            lvRows = lvRows.concat(cell('活文件', lua ? lua.name + '  ' + fmtSize(lua.size) : '需在编辑器里给容器节点挂脚本', 'e'));
            lvRows = lvRows.concat(cell('地图存档', cur.gil ? fmtSize(cur.gil.size) : '无', 'f'));
            lvRows = lvRows.concat(cell('日志局面', String(cur.logCount), 'g'));
            lvRows = lvRows.concat(cell('最近一局', cur.latestLog ? cur.latestLog.name : '—', 'h'));
          } else {
            lvRows = lvRows.concat(cell('提示', '没扫到关卡目录 —— 确认编辑器开过图，或检查 MILIASTRA_LOCALLOW', 'i'));
          }
        } else {
          lvRows = lvRows.concat(cell('状态', busy ? '读取中…' : '（未加载）', 'j'));
        }

        var mapRows = [];
        var mapDot = 'ok';
        if (mapInfo) {
          var lv = mapInfo.level || {};
          mapRows = mapRows.concat(cell('名称 / 版本', (lv.name || '（无名）') + '  v' + (mapInfo.version || '?'), 'm1'));
          mapRows = mapRows.concat(cell('客户端控件', mapInfo.controlCount + ' 条 · 可创建模板 ' + mapInfo.templateCount + ' 条', 'm2'));
          // 2026-09-23 新增：静态读出来的「这图是哪版存的 / 有哪些阵营与出生点 / 摆了多少东西」
          if (mapInfo.clientVersion) {
            mapRows = mapRows.concat(cell('存图客户端', mapInfo.clientVersion
              + (mapInfo.resourceVersions && mapInfo.resourceVersions.length ? '　资源 ' + mapInfo.resourceVersions.join(' / ') : ''), 'm5'));
          }
          var lc = mapInfo.levelConfig;
          if (lc) {
            var fac = (lc.factions || []).map(function (f) { return '#' + f.index + ' ' + f.name; }).join('　');
            mapRows = mapRows.concat(cell('阵营', (lc.factions || []).length + ' 个' + (fac ? '　' + fac : ''), 'm6'));
            mapRows = mapRows.concat(cell('出生点 / 预设点',
              (lc.spawnPoints || []).length + ' / ' + (lc.presetPoints || []).length
              + ((lc.spawnPoints || []).length ? '　' + lc.spawnPoints.join('、') : ''), 'm7'));
          }
          if (mapInfo.sceneObjectCount != null) {
            mapRows = mapRows.concat(cell('场景对象', mapInfo.sceneObjectCount + ' 条'
              + ((mapInfo.sceneObjectSample || []).length ? '　如 ' + mapInfo.sceneObjectSample.slice(0, 3).map(function (x) { return x.name; }).join('、') : ''), 'm8'));
          }
        } else {
          mapRows = mapRows.concat(cell('地图', busy ? '读取中…' : '（无 .gil）', 'm4'));
        }
        if (mapInfo && mapInfo.dynamicCreateLikelyBroken) mapDot = 'err';
        var mapKids = [React.createElement(KVGrid, { rows: mapRows, key: 'kv' })];
        if (mapInfo && (mapInfo.templates || []).length) {
          mapKids.push(React.createElement('div', { key: 'pills' },
            mapInfo.templates.map(function (t) {
              return React.createElement('span', { className: PLUGIN + '-pill', key: t.id }, t.name + ' ' + t.id);
            })));
        }
        if (mapInfo && mapInfo.dynamicCreateLikelyBroken) {
          mapKids.push(React.createElement('div', { className: PLUGIN + '-err', key: 'warn' },
            '模板区没有独立模板 —— 脚本动态创建控件会全部返回 nil。请到「客户端控件模板」里把图片/文本框各存为一条独立模板，再保存地图。'));
        }

        // 关卡选择器：默认**自动跟随**（作者在编辑器里换图，面板自己切过去）；点某个关卡就切成手动
        var allLevels = (status && status.levels) || [];
        var autoId = status && status.current ? status.current.levelId : '';
        var lvKids = [];
        lvKids.push(React.createElement('div', { className: PLUGIN + '-row', key: 'r' },
          React.createElement('button', {
            className: PLUGIN + '-act' + (activeLevel ? '' : ' ' + PLUGIN + '-primary'),
            style: { padding: '3px 9px', fontSize: '11px' },
            onClick: function () { setActiveLevel(''); setActiveFile(''); },
            title: '跟着 miliastra_health 判定的「当前关卡」走',
          }, activeLevel ? '自动跟随' : '● 自动跟随'),
          React.createElement('span', { className: PLUGIN + '-hint', key: 'h' },
            activeLevel ? '已手动锁定 ' + activeLevel : '当前 ' + (autoId || '—'))));
        if (allLevels.length) {
          lvKids.push(React.createElement('div', { className: PLUGIN + '-log', key: 'list', style: { maxHeight: 132 } },
            allLevels.map(function (x) {
              var on = x.levelId === (activeLevel || autoId);
              var lua = (x.luaFiles || []).map(function (f) { return f.name; }).join(',');
              return React.createElement('div', {
                key: x.accountId + '/' + x.levelId + '/' + x.layout,
                style: {
                  display: 'flex', gap: '6px', alignItems: 'center', margin: '3px 0', cursor: 'pointer',
                  color: on ? '#a5d8ff' : undefined, fontWeight: on ? 600 : 400,
                },
                title: x.brand + ' · 账号 ' + x.accountId + ' · ' + (x.layout === 'root-gil' ? '根目录图' : '本机图'),
                onClick: function () { setActiveLevel(x.levelId); setActiveFile(''); },
              },
                React.createElement('span', { style: { flex: '0 0 auto' } }, (on ? '● ' : '○ ') + x.levelId),
                React.createElement('span', {
                  style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                }, (x.brand === '原神' ? '' : 'Beta ') + (lua || '（无脚本）')),
                React.createElement('span', { style: { flex: '0 0 auto', opacity: .7 } },
                  x.gil ? Math.round(x.gil.size / 1024) + 'KB' : '—'));
            })));
        } else {
          lvKids.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'x' }, '没扫到关卡'));
        }

        var col1 = [
          sec('关卡', allLevels.length + ' 个', lvKids, 'secLv', activeLevel ? 'warn' : 'ok'),
          sec('关卡与文件', null, React.createElement(KVGrid, { rows: lvRows }), 'sec1', status ? 'ok' : 'warn'),
          sec('地图体检', '直接读 .gil', mapKids, 'sec2', mapDot),
        ];

        // 编辑器 / 游戏进程（best-effort；拿不到就显示"未知"，不影响别的）
        var pr = status && status.processes;
        if (pr) {
          var prRows = [];
          if (pr.available) {
            (pr.entries || []).forEach(function (e, i) {
              prRows = prRows.concat(cell(e.label,
                (e.running ? '✅ 在跑' : '— 未运行') + (e.running ? '  ' + e.instances + ' 实例 / ' + e.memoryMB + 'MB' : ''), 'p' + i));
            });
            prRows = prRows.concat(cell('能否试玩',
              pr.summary && pr.summary.canPlaytest ? '✅ 编辑器 + 游戏都在' : '⚠️ 需要编辑器与游戏进程同时在', 'p9'));
          } else {
            prRows = prRows.concat(cell('进程', '读不到（' + (pr.error || '未知') + '）', 'p0'));
          }
          col1.push(sec('进程', '免截图看环境', React.createElement(KVGrid, { rows: prRows }), 'secPr',
            pr.available && pr.summary && pr.summary.canPlaytest ? 'ok' : 'warn'));
        }

        /* ---------------- 第 2 栏：代码 ---------------- */

        var fileRows = [];
        if (fileInfo && fileInfo.inspected) {
          var fi = fileInfo.inspected;
          fileRows = fileRows.concat(cell('文件', basename(fi.path), 'f1'));
          fileRows = fileRows.concat(cell('大小 / 行数', fmtSize(fi.size) + ' / ' + fi.lineCount + ' 行', 'f2'));
          fileRows = fileRows.concat(cell('SHA-256', String(fi.sha256 || '').slice(0, 16) + '…', 'f3'));
          fileRows = fileRows.concat(cell('BOM', fi.bom ? '❌ 有 —— 会让 Lua 报错' : '✅ 无', 'f4'));
          fileRows = fileRows.concat(cell('编码', fi.utf8Ok ? '✅ 合法 UTF-8' : '❌ 非法 UTF-8', 'f5'));
          fileRows = fileRows.concat(cell('中文注释', fi.hasChinese ? '有' : '无', 'f6'));
        } else {
          fileRows = fileRows.concat(cell('活文件', busy ? '读取中…' : '（无）', 'f0'));
        }

        var scRows = [];
        var scDot = 'warn';
        if (scriptInfo) {
          var shaOf = function (o) { return o && o.sha256 ? String(o.sha256).slice(0, 10) : '—'; };
          var consistent = scriptInfo.match === true;
          scDot = consistent ? 'ok' : 'warn';
          scRows = scRows.concat(cell('结论', consistent ? '✅ 一致' : '❌ 不一致', 's1'));
          scRows = scRows.concat(cell('地图快照', shaOf(scriptInfo.embedded) + (scriptInfo.embedded ? '  ' + fmtSize(scriptInfo.embedded.bytes) : ''), 's2'));
          scRows = scRows.concat(cell('本地活文件', shaOf(scriptInfo.live), 's3'));
          if (!consistent) {
            scRows = scRows.concat(cell('怎么办', scriptInfo.embedded ? '在编辑器里存盘，把当前活文件写进地图' : '地图里没有脚本映射记录', 's4'));
          }
        } else {
          scRows = scRows.concat(cell('脚本一致', busy ? '读取中…' : '（未知）', 's0'));
        }

        var bkKids = [];
        var bkDot = 'ok';
        if (backups && backups.ok !== false) {
          bkKids.push(React.createElement(KVGrid, {
            rows: [].concat(
              cell('份数 / 位置', backups.count + ' 份  ' + String(backups.backupDir || '').split('\\').slice(-2).join('\\'), 'b1'),
              cell('固定名备份', backups.fixedBackup ? basename(backups.fixedBackup) : '（还没有）', 'b2'),
            ),
            key: 'kv',
          }));
          // 作者要求：备份要写在**被替换的文件旁边** + 固定统一的名字 + 明确提示还原操作。
          bkKids.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'where' }, BACKUP_NOTE));

          // ① 最省事的一条路：不挑版本，直接用固定名那份
          if (backups.fixedExists) {
            bkKids.push(React.createElement('div', { className: PLUGIN + '-row', key: 'fixed' },
              React.createElement('button', {
                className: PLUGIN + '-act ' + PLUGIN + '-primary',
                disabled: busy,
                title: '把固定名那份（最近一次覆盖前的版本）写回活文件',
                onClick: function () { setPendingRestore(RESTORE_FIXED); setNote(''); setErr(''); },
              }, '还原到最新备份'),
              React.createElement('span', { className: PLUGIN + '-hint' },
                basename(backups.fixedBackup || '') + ' = 最近一次覆盖前的那一版')));
          } else if ((backups.count || 0) > 0) {
            bkKids.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'nofixed' },
              '还没有固定名备份（Host 可能是旧版 —— 重启 dsh web 后每次部署都会自动写一份）。下面可以逐条还原。'));
          }

          var totalBytes = (backups.entries || []).reduce(function (s, e) { return s + (e.size || 0); }, 0);
          if ((backups.count || 0) >= 20 || totalBytes > 5 * 1024 * 1024) {
            bkDot = 'warn';
            bkKids.push(React.createElement('div', { className: PLUGIN + '-note', key: 'toomany' },
              '备份已 ' + backups.count + ' 份 / ' + fmtSize(totalBytes) + ' —— 不会自动删，要清理得自己去 _backup 目录收。'));
          }
          if ((backups.entries || []).length) {
            bkKids.push(React.createElement('div', { className: PLUGIN + '-log', key: 'list', style: { maxHeight: 170 } },
              backups.entries.slice(0, 12).map(function (e) {
                return React.createElement('div', { key: e.path, style: { display: 'flex', gap: '6px', alignItems: 'center', margin: '3px 0' } },
                  React.createElement('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                    (e.fixed ? '★ ' : '') + e.name + '  ' + e.size + 'B'
                    + (e.createdAt ? '  ' + String(e.createdAt).replace('T', ' ').slice(5, 19) : '')),
                  React.createElement('button', {
                    className: PLUGIN + '-act',
                    style: { padding: '2px 8px', fontSize: '11px' },
                    onClick: function () { setPendingRestore(e.path); setNote(''); setErr(''); },
                  }, '还原'));
              })));
            if (pendingRestore) {
              var isFixedPick = pendingRestore === RESTORE_FIXED;
              bkKids.push(React.createElement('div', { className: PLUGIN + '-err', key: 'confirm' },
                '确认用 ' + (isFixedPick ? basename(backups.fixedBackup || '固定名备份') + '（最新）' : basename(pendingRestore))
                + ' 覆盖当前活文件 ' + (activeFile || '') + ' ？'
                + '还原前会先把当前版本再备份一次；写完会校验 SHA，不一致会自动回滚。',
                React.createElement('div', { className: PLUGIN + '-row', style: { marginTop: '5px' } },
                  React.createElement('button', { className: PLUGIN + '-act ' + PLUGIN + '-primary', onClick: doRestore, disabled: busy, key: 'yes' }, '确认覆盖'),
                  React.createElement('button', { className: PLUGIN + '-act', onClick: function () { setPendingRestore(''); }, key: 'no' }, '取消'))));
            }
          } else {
            bkKids.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'none' }, '还没有备份 —— 首次部署时自动产生。'));
          }
        } else {
          bkKids.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'x' }, busy ? '读取中…' : '（读取失败）'));
        }

        // 活文件选择器：**一个关卡可以有多个 .lua**，先明确"现在操作哪一个"，再谈其他
        var allFiles = (cur && cur.luaFiles) || [];
        var fileSelKids = [];
        if (allFiles.length) {
          fileSelKids.push(React.createElement('div', { key: 'pills' },
            allFiles.map(function (f) {
              var on = f.name === activeFile;
              return React.createElement('span', {
                className: PLUGIN + '-pill',
                key: f.name,
                title: f.path,
                style: on
                  ? { cursor: 'pointer', background: 'linear-gradient(135deg,rgba(125,211,252,.40),rgba(249,168,212,.40))', borderColor: 'rgba(125,211,252,.65)', color: '#0d1626', fontWeight: 600 }
                  : { cursor: 'pointer' },
                onClick: function () {
                  if (on) return;
                  setActiveFile(f.name);
                  setPendingRestore('');
                  setLogs([]);
                },
              }, (on ? '● ' : '') + f.name + '  ' + fmtSize(f.size));
            })));
          fileSelKids.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'h' },
            allFiles.length > 1
              ? '共 ' + allFiles.length + ' 个活文件 —— 下面所有操作（体检 / 比对 / 备份 / 部署 / 还原）都只作用于选中的这个'
              : '该关卡只有 1 个活文件'));
        } else {
          fileSelKids.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'x' }, '该关卡还没有活文件 —— 先在编辑器里给容器节点挂客户端脚本'));
        }

        var col2 = [
          sec('活文件', '选中的那个才被操作', fileSelKids, 'secSel', allFiles.length ? 'ok' : 'warn'),
          sec('活文件体检', null, React.createElement(KVGrid, { rows: fileRows }), 'secF',
            fileInfo && fileInfo.inspected && fileInfo.inspected.bom ? 'err' : 'ok'),
          sec('脚本一致性', '地图 vs 活文件', React.createElement(KVGrid, { rows: scRows }), 'secS', scDot),
          sec('备份', '覆盖前的安全网', bkKids, 'secB', bkDot),
          sec('部署到活文件', null, [
            React.createElement('div', { className: PLUGIN + '-row', key: 'r' },
              React.createElement('input', {
                className: PLUGIN + '-inp',
                placeholder: '本地 .lua 绝对路径',
                value: srcPath,
                onChange: function (e) { setSrcPath(e.target.value); },
                key: 'in',
              }),
              React.createElement('button', { className: PLUGIN + '-act ' + PLUGIN + '-primary', onClick: doDeploy, disabled: busy, key: 'dp' }, '部署')),
            React.createElement('div', { className: PLUGIN + '-hint', key: 'h' },
              '覆盖前自动备份（写在活文件旁边的 _backup\\，固定名 + 带时间戳各一份） · 原子写（断电不会留半截文件） · 校验 SHA-256 · 拒收带 BOM / 非法 UTF-8'),
          ], 'secD', 'ok'),
        ];

        /* ---------------- 第 3 栏：日志 ---------------- */

        var logRows = [];
        if (cur) {
          logRows = logRows.concat(cell('局面数', String(cur.logCount), 'l1'));
          logRows = logRows.concat(cell('最近一局', cur.latestLog ? cur.latestLog.name : '—', 'l2'));
        }
        if (tags.length) {
          logRows = logRows.concat(cell('标签数', String(tags.length), 'l3'));
        }
        var logKids = [];
        if (logRows.length) logKids.push(React.createElement(KVGrid, { rows: logRows, key: 'kv' }));

        /*
         * ⚠️ 这里曾经有一块「试玩体检」结论条（红框：「最近一局是 2 小时前写的 → 可能原因 → 下一步」），
         * 并在打开面板时**自动跑一次**。作者的原话是「做个是什么鬼东西 下面一大段一直在」——
         * 它是常驻的：只要最近一局是几小时前写的，那段警告就会**永远挂在面板最上面**，
         * 而这对用户没有一点信息量（他当然知道自己没在试玩）。
         *
         * 结论：整块删掉（工具侧的 `miliastra_log op=diagnose` 也一并删了）。
         * 「最近一局是什么时候写的」这个事实本来就在 KV 行里，看一眼就够，不需要替用户下结论。
         */
        logKids.push(React.createElement('div', { className: PLUGIN + '-row', key: 'r' },
          React.createElement('button', { className: PLUGIN + '-act ' + PLUGIN + '-primary', onClick: function () { doLogs(tagFilter); }, disabled: busy, key: 't' }, '取日志'),
          React.createElement('button', { className: PLUGIN + '-act', onClick: doTags, disabled: busy, key: 'g' }, 'TAG 汇总'),
          React.createElement('button', {
            className: PLUGIN + '-act' + (autoLog ? ' ' + PLUGIN + '-primary' : ''),
            style: { padding: '5px 10px', fontSize: '11px' },
            key: 'auto',
            title: '盯着日志文件：新的一局出现、或文件还在变大，就说明试玩在动；安静 6 秒后自动取回那一局。',
            onClick: function () { setAutoLog(!autoLog); },
          }, autoLog ? '试玩完自动取：开' : '试玩完自动取：关')));
        if (autoLog) {
          logKids.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'autostat' },
            autoState
              ? React.createElement('span', null,
                React.createElement('b', null, autoPhaseMark(autoState.phase)),
                ' ' + autoState.reason
                + (autoState.name && autoState.phase !== 'idle' ? '（局 ' + shortSessionName(autoState.name) + '）' : ''))
              : React.createElement('span', null, '正在守望日志文件…（每 4 秒看一次）')));
        }
        logKids.push(React.createElement('div', { className: PLUGIN + '-row', key: 'r2' },
          React.createElement('input', {
            className: PLUGIN + '-inp',
            placeholder: '按 TAG 过滤（如 P5D）',
            value: tagFilter,
            onChange: function (e) { setTagFilter(e.target.value); },
            key: 'fi',
          })));
        if (tags.length) {
          logKids.push(React.createElement('div', { key: 'tagpills' },
            tags.slice(0, 14).map(function (t) {
              return React.createElement('span', {
                className: PLUGIN + '-pill',
                key: t.tag,
                style: { cursor: 'pointer' },
                onClick: function () { setTagFilter(t.tag); doLogs(t.tag); },
                title: '点一下只看这个标签',
              }, t.tag + '×' + t.count);
            })));
        }
        // 历史局面：点某一局就看那一局（默认最新那局）
        if (sessions.length) {
          logKids.push(React.createElement('div', { key: 'sess' },
            sessions.slice(0, 10).map(function (s) {
              var on = s.name === activeSession || (!activeSession && sessions[0] && s.name === sessions[0].name);
              return React.createElement('span', {
                className: PLUGIN + '-pill',
                key: s.name,
                title: s.mtime + '  ' + s.size + 'B',
                style: on
                  ? { cursor: 'pointer', background: 'linear-gradient(135deg,rgba(125,211,252,.40),rgba(249,168,212,.40))', borderColor: 'rgba(125,211,252,.65)', color: '#0d1626', fontWeight: 600 }
                  : { cursor: 'pointer' },
                onClick: function () { setTagFilter(''); doLogs('', s.name); },
              }, (on ? '● ' : '') + s.name.replace(/^\d{4}-\d{2}-\d{2}_/, '').replace(/_\d+_\d+\.gia$/, ''));
            })));
        }
        if (logs.length) {
          var badCount = logs.filter(function (x) { return x.bad; }).length;
          var warnCount = logs.filter(function (x) { return x.warn; }).length;
          var shown = onlyBad ? logs.filter(function (x) { return x.bad || x.warn; }) : logs;
          logKids.push(React.createElement('div', { className: PLUGIN + '-row', key: 'lbar' },
            React.createElement('span', { className: PLUGIN + '-hint' },
              logs.length + ' 行' + (badCount ? ' · 疑似异常 ' + badCount : '') + (warnCount ? ' · 警告 ' + warnCount : '')),
            React.createElement('button', {
              className: PLUGIN + '-act' + (onlyBad ? ' ' + PLUGIN + '-primary' : ''),
              style: { padding: '2px 9px', fontSize: '10.5px', marginLeft: 'auto' },
              key: 'ob',
              title: '按关键词粗筛（错误/失败/异常/error…）。这只是一个过滤器，判据仍以正文为准。',
              onClick: function () { setOnlyBad(!onlyBad); },
            }, onlyBad ? '显示全部' : '只看异常')));
          if (!shown.length) {
            logKids.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'lb' },
              '这一批里没有疑似异常的行（关键词粗筛，不代表一定没问题）'));
          } else {
            logKids.push(React.createElement('div', { className: PLUGIN + '-log', key: 'log' },
              shown.map(LogRow)));
          }
        }

        /*
         * 试玩探针卡片 —— 这一段文案是**给使用者看的**，不是给实现者看的。
         *
         * 之前写「试玩探针 / 只读诊断脚本」+ 三个光秃秃的 ping / tree / instantiate，
         * 作者本人的反馈是「没看懂试玩探针作用」。所以现在：
         *   ① 顶部先把「试玩探针是什么 / 为什么需要 / 代价是什么」讲清楚；
         *   ② 每个模板显示「大白话名 + 一句话」，选中的那个再展开 what/when；
         *   ③ 四步流程直接写在卡片上（含最后一步「还原你的脚本」），并且真的给一键还原。
         * 模板清单与说明来自 Host 的 `op=list`（单一口径），拿不到才用兜底文案。
         */
        var probeMeta = (probeInfo && probeInfo.templates && probeInfo.templates.length)
          ? probeInfo
          : { templates: PROBE_FALLBACK.map(function (x) { return x.template; }), info: PROBE_FALLBACK, overview: PROBE_OVERVIEW_FALLBACK };
        var probeById = {};
        (probeMeta.info || []).forEach(function (x) { if (x && x.template) probeById[x.template] = x; });
        var curInfo = probeById[probeTemplate] || { label: probeTemplate, oneLine: '', what: '', when: '' };
        var ov = probeMeta.overview || {};

        var probeKids = [];

        // ⚠️ Host 代码是**启动时 import** 的：`patchReload: live` 不会重新 import Host 模块，
        // 所以「磁盘上加了新模板」≠「跑着的 Host 认这个模板」。这里显式报出来，
        // 否则用户只会看到「面板少了一个按钮」而不知道为什么。
        var knownTpls = PROBE_FALLBACK.map(function (x) { return x.template; });
        var hostTpls = probeMeta.templates || [];
        var missingOnHost = knownTpls.filter(function (t) { return hostTpls.indexOf(t) < 0; });
        if (missingOnHost.length) {
          probeKids.push(React.createElement('div', { className: PLUGIN + '-err', key: 'stale' },
            '⚠️ 运行中的 Host 是旧版：它只认 ' + hostTpls.length + ' 个试玩探针，少了 ' + missingOnHost.join('、')
            + '。重启 dsh web 之后才会出现 —— 光刷新这个页面不够（Host 代码是启动时加载的）。'));
        }

        // ① 这是什么（大白话）
        probeKids.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'what' },
          React.createElement('div', null, React.createElement('b', null, '试玩探针是干嘛的：'), ov.what || '临时替掉你脚本的一小段程序，试玩时跑一次，把游戏内部信息打到日志里。'),
          React.createElement('div', { style: { marginTop: '3px' } }, React.createElement('b', null, '什么时候用：'), ov.why || '有些事光看代码看不出来，得让游戏真跑一遍。'),
          React.createElement('div', { style: { marginTop: '3px' } }, React.createElement('b', null, '要付什么代价：'), ov.cost || '会临时覆盖活文件，试玩那一局你的玩法不会跑（自动备份，用完可一键还原）。')));

        // ② 四步流程
        probeKids.push(React.createElement('div', { className: PLUGIN + '-kv', key: 'steps' },
          React.createElement('span', { className: PLUGIN + '-k' }, '流程'),
          React.createElement('span', { className: PLUGIN + '-v' },
            (ov.steps && ov.steps.length ? ov.steps : ['选试玩探针', '部署', '重新试玩一局', '收回结论 + 还原脚本'])
              .map(function (s, i) { return React.createElement('span', { key: 's' + i },
                React.createElement('span', { className: PLUGIN + '-pill' }, String(i + 1) + '. ' + s),
                i < 3 ? ' ' : null); }))));

        // ③ 选一个试玩探针（大白话名 + 一句话）
        probeKids.push(React.createElement('div', { className: PLUGIN + '-row', key: 'tpl' },
          (probeMeta.templates || []).map(function (t) {
            var m = probeById[t] || {};
            return React.createElement('button', {
              className: PLUGIN + '-act' + (probeTemplate === t ? ' ' + PLUGIN + '-primary' : ''),
              style: { padding: '3px 9px', fontSize: '11px' },
              title: (m.what ? m.what + ' ' : '') + (m.when ? '什么时候用：' + String(m.when).replace(/<[^>]+>/g, '') : ''),
              key: t,
              onClick: function () { setProbeTemplate(t); setProbeResult(null); },
            }, (m.label || t) + '（' + t + '）');
          })));

        // ④ 选中那个的详细说明 —— 「这个试玩探针能帮我回答什么问题」
        probeKids.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'sel' },
          React.createElement('div', null, React.createElement('b', null, curInfo.label + '（' + probeTemplate + '）'), '：', curInfo.oneLine || ''),
          curInfo.what ? React.createElement('div', { style: { marginTop: '3px' }, dangerouslySetInnerHTML: { __html: '做什么：' + curInfo.what } }) : null,
          curInfo.when ? React.createElement('div', { style: { marginTop: '3px' }, dangerouslySetInnerHTML: { __html: '什么时候点它：' + curInfo.when } }) : null));

        probeKids.push(React.createElement('div', { className: PLUGIN + '-row', key: 'tag' },
          React.createElement('input', {
            className: PLUGIN + '-inp',
            placeholder: '日志标签（如 P1）',
            value: probeTag,
            onChange: function (e) { setProbeTag(e.target.value); },
            key: 'i',
          }),
          React.createElement('button', {
            className: PLUGIN + '-act', disabled: busy, key: 'dp',
            onClick: function () { setPendingProbe(true); setNote(''); setErr(''); },
          }, '① 部署试玩探针'),
          React.createElement('button', {
            className: PLUGIN + '-act ' + PLUGIN + '-primary', disabled: busy, key: 'co',
            onClick: doCollectProbe,
          }, '③ 收回结论')));

        // ① 和 ③ 之间那一步**必须人来做**，所以单独写一行说明，别让编号看着像缺了一块
        probeKids.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'step2' },
          React.createElement('span', { className: PLUGIN + '-pill' }, '②'),
          ' 这一步得你手动做：到编辑器里「停止试玩 → 重新试玩一局」（部署不会热加载）。'
          + '起来后等 3~5 秒让试玩探针打完字，再回来点 ③。'));

        if (pendingProbe) {
          probeKids.push(React.createElement('div', { className: PLUGIN + '-err', key: 'warn' },
            '⚠️ 这一步会用试玩探针源码覆盖活文件 ' + (activeFile || '（当前选中）') + '（Host 会先自动备份）。'
            + '覆盖后在编辑器里「停止试玩 → 重新试玩一局」才会生效，否则跑的还是旧脚本。',
            React.createElement('div', { className: PLUGIN + '-row', style: { marginTop: '5px' } },
              React.createElement('button', { className: PLUGIN + '-act ' + PLUGIN + '-primary', onClick: doDeployProbe, disabled: busy, key: 'y' }, '确认覆盖'),
              React.createElement('button', { className: PLUGIN + '-act', onClick: function () { setPendingProbe(false); }, key: 'n' }, '取消'))));
        }

        // 已部署 → 提醒第 2 步，并给出第 4 步「还原我的脚本」的一键按钮
        if (probeBackup) {
          probeKids.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'deployed' },
            React.createElement('div', null, '✅ 试玩探针已部署 —— 现在请去编辑器里重新试玩一局（第 2 步）。'),
            React.createElement('div', { style: { marginTop: '3px' } }, '试玩完回来点「③ 收回结论」；拿完结论记得还原你的脚本（第 4 步）—— 否则活文件一直是试玩探针，你的玩法不会跑。'),
            React.createElement('div', { className: PLUGIN + '-row', style: { marginTop: '5px' } },
              React.createElement('button', {
                className: PLUGIN + '-act ' + PLUGIN + '-primary', disabled: busy, key: 'rs',
                title: '用部署试玩探针前自动生成的那份备份覆盖回去',
                onClick: doRestoreProbe,
              }, '④ 还原我的脚本'))));
        }
        if (probeResult && probeResult.hit) {
          probeKids.push(React.createElement('div', { className: PLUGIN + '-log', key: 'res', style: { maxHeight: 150 } },
            (probeResult.lines || []).join('\n')));
        } else if (probeResult) {
          probeKids.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'no' },
            '这一局里没有 [' + probeResult.tag + '] 的输出。两个最常见原因：'
            + '① 部署后没有重新试玩（部署不会热加载）；② 试玩探针起来了但试玩结束太快（等 3~5 秒再退）。'));
        }

        /*
         * 「读界面控件」—— 高级诊断区的第一块。
         *
         * 这是**静态**读（从 `.gil` 存档读），不改任何文件、不用试玩，所以放在折叠区里也没风险；
         * 想要**运行时**的控件树（脚本眼里实际挂了什么）就去点下面的试玩探针「看控件」。
         *
         * 为什么它重要：写客户端脚本最缺的两个号 —— 容器节点索引 / 控件模板索引 ——
         * 以前得靠人抄或写试玩探针试，现在这里直接读出来。
         */
        var uiKids = [];
        uiKids.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'what' },
          '从地图存档里直接读「界面控件谱系」（模板索引 / 名字 / 父子）。'
          + '静态读取，不改任何文件、不用试玩。写脚本要的「容器节点索引 / 控件模板索引」就在这里。'));
        uiKids.push(React.createElement('div', { className: PLUGIN + '-row', key: 'btn' },
          React.createElement('button', {
            className: PLUGIN + '-act ' + PLUGIN + '-primary', disabled: uiBusy || busy, key: 'r',
            onClick: doReadUi,
          }, uiBusy ? '读取中…' : '读界面控件')));

        if (uiInfo && uiInfo.ok !== false) {
          var realTemplates = (uiInfo.likelyTemplates || []).filter(function (x) { return x.name !== '容器节点'; });
          var containerNodes = (uiInfo.records || []).filter(function (x) { return x.name === '容器节点'; });

          // ① 真正能被脚本创建的模板 —— 这是写脚本直接要用的号
          uiKids.push(React.createElement('div', { key: 'tpl' },
            React.createElement('div', { className: PLUGIN + '-hint' },
              React.createElement('b', null, '可被脚本创建的控件模板（' + realTemplates.length + ' 个）'),
              ' —— 写 game.InstantiateClientUIControl 就用这些号'),
            realTemplates.length
              ? React.createElement('div', { className: PLUGIN + '-log', key: 'l', style: { maxHeight: 120 } },
                realTemplates.map(function (x) {
                  return React.createElement('div', { key: x.id, style: { display: 'flex', gap: '8px' } },
                    React.createElement('span', { style: { flex: '1 1 auto' } }, x.name),
                    React.createElement('span', { style: { fontFamily: 'ui-monospace,Consolas,monospace', color: '#a5d8ff' } }, String(x.id)));
                }))
              : React.createElement('div', { className: PLUGIN + '-err', key: 'none' },
                '⚠️ 一个都没有 —— 说明「客户端控件模板库」是空的。'
                + '这时脚本动态创建任何控件都会返回 nil。'
                + '请到 界面控件组管理 → 界面控件组库 → 客户端控件模板 →【添加客户端控件】各存一条独立模板，然后保存地图。')));

          // ② 容器节点 —— 不一定能创建，但常被当成「容器节点索引」用
          uiKids.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'cnt' },
            React.createElement('b', null, '容器节点（' + containerNodes.length + ' 个）'),
            '：',
            containerNodes.map(function (x) { return x.id; }).join(' / ') || '（无）',
            '　—— 画布上摆的容器实例，不能被脚本创建（但脚本要挂东西时认的就是这类号）'));

          // ③ 全部记录（默认折叠，别一上来铺 37 行）
          uiKids.push(React.createElement('div', { className: PLUGIN + '-row', key: 'all' },
            React.createElement('button', {
              className: PLUGIN + '-act', style: { padding: '2px 9px', fontSize: '10.5px' }, key: 't',
              onClick: function () { setUiRaw(!uiRaw); },
            }, (uiRaw ? '收起' : '展开') + '全部 ' + (uiInfo.count || 0) + ' 条记录')));
          if (uiRaw) {
            uiKids.push(React.createElement('div', { className: PLUGIN + '-log', key: 'raw', style: { maxHeight: 220 } },
              (uiInfo.records || []).map(function (x) {
                return React.createElement('div', { key: x.id },
                  (x.parent == null ? '● ' : '└ ') + x.id + '  ' + x.name
                  + (x.parent == null ? '  （无父节点）' : '  ← ' + x.parent));
              })));
          }
          uiKids.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'tip' },
            '提示：「无父节点」只是「候选」条件。真机实测佐证（来源：关卡 1073741833《冰镜·火烛》那次实测，不是本关）：'
            + '而 1073741863~1866（画布上的实例）一律返回 nil。想确证某个号能不能创建，用试玩探针「试钥匙」。'));
        }

        /*
         * ---------------- 截图卡片 ----------------
         *
         * 这一段存在的理由**不是**「我们实现了截图」，而是作者的这句话：
         * 「做游戏截图希望有这个功能跟日志一样要提示用户，是存到插件运行目录要提示用户清理」。
         * 也就是：截图功能本身不难，难的是**别让图在用户不知道的地方越堆越多**。
         * 所以卡片上一开始就写清楚「存在哪 / 多少张 / 占多大 / 不会自动删」。
         */
        var lastCap = shotInfo && shotInfo.lastCapture ? shotInfo.lastCapture : null;
        var shotKids = [];

        var shotRows = [];
        shotRows = shotRows.concat(cell('存放目录', (shotInfo && shotInfo.dir) || '（还没截过）', 'sd'));
        shotRows = shotRows.concat(cell('现有', (shotInfo ? (shotInfo.count || 0) : 0) + ' 张'
          + ((shotInfo && shotInfo.totalText) ? ' · ' + shotInfo.totalText : ''), 'sn'));
        shotRows = shotRows.concat(cell('最近一张',
          (shotInfo && shotInfo.newest && shotInfo.newest.name) || '—', 'sl'));
        shotKids.push(React.createElement(KVGrid, { rows: shotRows, key: 'kv' }));

        shotKids.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'where' },
          React.createElement('div', null, plain('存在「插件数据目录」下（默认 ~/.dsh/miliastra/shots）——'
            + '不放进游戏存档目录（那是米哈游的地盘），也不放插件包目录（升级会整个替换掉，图会没）。')),
          React.createElement('div', { style: { marginTop: '3px' } }, plain('不会自动删。清理要你自己点：'
            + '先看「会删哪些」，确认了才真删。'))));

        shotKids.push(React.createElement('div', { className: PLUGIN + '-row', key: 'b' },
          React.createElement('button', {
            className: PLUGIN + '-act ' + PLUGIN + '-primary', disabled: shotBusy, key: 'g',
            title: '抓原神客户端窗口（试玩时就是游戏画面）。不需要它在前台。',
            onClick: function () { doCapture('game'); },
          }, shotBusy ? '截图中…' : '截取游戏画面'),
          React.createElement('button', {
            className: PLUGIN + '-act', disabled: shotBusy, key: 'e',
            title: '抓千星沙箱编辑器窗口（节点图资源管理器等）',
            onClick: function () { doCapture('editor'); },
          }, '截编辑器'),
          React.createElement('button', {
            className: PLUGIN + '-act', disabled: shotBusy, key: 'l',
            title: '重新列一遍截图目录',
            onClick: doShotList,
          }, '列目录'),
          React.createElement('button', {
            className: PLUGIN + '-act', disabled: shotBusy, key: 'c',
            title: '先只算「会删哪些」（保留最新 5 张 + 最近 7 天），看清楚了再确认',
            onClick: doShotCleanPlan,
          }, '清理…')));

        // 截图回执：**截到的到底是哪个窗口**。第一版抓错程序就是因为回执里没这个信息。
        if (lastCap && lastCap.ok) {
          shotKids.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'last' },
            plain('截到的是「' + (lastCap.title || lastCap.process) + '」pid=' + lastCap.pid
              + ' · ' + lastCap.width + '×' + lastCap.height
              + ' · ' + (lastCap.mode === 'printwindow' ? '窗口自绘（不需要前台）' : '屏幕抓取')
              + ' · 黑比 ' + (lastCap.blackRatio != null ? lastCap.blackRatio : '—'))));
        }
        if (lastCap && lastCap.ok && lastCap.suspect) {
          shotKids.push(React.createElement('div', { className: PLUGIN + '-err', key: 'suspect' },
            plain('⚠️ 这张图可能不可信：' + (lastCap.warning || ''))));
        }
        if (lastCap && !lastCap.ok) {
          shotKids.push(React.createElement('div', { className: PLUGIN + '-err', key: 'shoterr' },
            plain('截图失败：' + (lastCap.error || ''))));
        }

        // 清理：先规划、再确认（删除不可恢复）
        if (cleanPlan) {
          shotKids.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'plan' },
            React.createElement('div', null, plain(cleanPlan.note || '')),
            (cleanPlan.planned || []).length
              ? React.createElement('div', { className: PLUGIN + '-log', style: { maxHeight: 110, marginTop: '4px' } },
                cleanPlan.planned.slice(0, 30).map(function (f) {
                  return React.createElement('div', { key: f.name }, f.name + '　' + f.sizeText);
                }))
              : null,
            React.createElement('div', { className: PLUGIN + '-row', style: { marginTop: '6px' } },
              React.createElement('button', {
                className: PLUGIN + '-act ' + PLUGIN + '-primary',
                disabled: shotBusy || !(cleanPlan.planned || []).length,
                key: 'yes', onClick: doShotCleanConfirm,
              }, '确认删除 ' + ((cleanPlan.planned || []).length) + ' 张'),
              React.createElement('button', {
                className: PLUGIN + '-act', key: 'no', onClick: function () { setCleanPlan(null); },
              }, '取消'))));
        }

        /*
         * 缩略图预览（作者要求「图片最好有缩略图预览」）。
         *
         * 为什么要 Host 出小图、而不是直接 <img> 指原图：一张原图 2.4 MB，列十来张就是 30 MB，
         * 面板每次刷新都会重下。所以 Host 侧在**截图时**就顺手生成一张 ~320px 的预览
         * （同一个 bitmap，不额外起进程），面板只加载预览；点一下开新标签看原图。
         */
        var shotUrl = function (name, thumb) {
          return PREFIX + '/shot?name=' + encodeURIComponent(name) + (thumb ? '&thumb=1' : '');
        };
        var shotFiles = (shotInfo && shotInfo.files) || [];
        // 最近截的那张单独放大显示 —— 「我刚才截的对不对」是第一眼要看的事
        var previewName = (lastCap && lastCap.file) || (shotInfo && shotInfo.newest && shotInfo.newest.name) || shotFiles[0] && shotFiles[0].name;
        if (previewName) {
          shotKids.push(React.createElement('a', {
            className: PLUGIN + '-preview', key: 'preview',
            href: shotUrl(previewName, false), target: '_blank', rel: 'noreferrer',
            title: '点开看原图（新标签页）',
          },
            React.createElement('img', { src: shotUrl(previewName, true), alt: previewName, loading: 'lazy' }),
            React.createElement('span', { className: PLUGIN + '-previewcap' },
              previewName + (lastCap && lastCap.width ? '　' + lastCap.width + '×' + lastCap.height : ''))));
        }
        if (shotFiles.length) {
          var grid = shotFiles.slice(0, showShotFiles ? 24 : 6);
          shotKids.push(React.createElement('div', { className: PLUGIN + '-thumbs', key: 'thumbs' },
            grid.map(function (f) {
              return React.createElement('a', {
                className: PLUGIN + '-thumb', key: f.name,
                href: shotUrl(f.name, false), target: '_blank', rel: 'noreferrer',
                title: f.name + '　' + (f.sizeText || '') + (f.mtime ? '　' + hhmm(f.mtime) : '') + '　（点开看原图）',
              },
                React.createElement('img', { src: shotUrl(f.name, true), alt: f.name, loading: 'lazy' }),
                React.createElement('span', { className: PLUGIN + '-thumbcap' }, (f.sizeText || '') + (f.mtime ? '　' + hhmm(f.mtime) : '')));
            })));
          shotKids.push(React.createElement('div', { className: PLUGIN + '-row', key: 'fl' },
            React.createElement('button', {
              className: PLUGIN + '-act', style: { padding: '2px 9px', fontSize: '10.5px' }, key: 't',
              onClick: function () { setShowShotFiles(!showShotFiles); },
            }, showShotFiles ? '收起' : '展开全部 ' + shotFiles.length + ' 张')));
        }

        /* ------------------------------------------------ 试玩开跑卡片（0.0.4） */

        var hms = function (s) { return String(s == null ? '' : s).replace(/\.\d+$/, ''); };
        var durText = function (sec) {
          if (sec == null || !isFinite(sec)) return '—';
          var m = Math.floor(sec / 60);
          var r = Math.round(sec % 60);
          return m ? (m + ' 分 ' + r + ' 秒') : (r + ' 秒');
        };
        var ptKids = [];
        var ptLive = !!(ptInfo && ptInfo.ok !== false && ptInfo.inPlaytest);
        var ptNow;
        if (!ptInfo) ptNow = '读取中…（第一次轮询还没回来）';
        else if (ptInfo.ok === false) ptNow = '读不到试玩日志' + (ptInfo.error ? '：' + ptInfo.error : '');
        else if (ptLive) ptNow = '🟢 试玩中 · 已跑 ' + durText(ptInfo.elapsedSec) + '（开跑 ' + hms(ptInfo.startedAt) + '）';
        else if (ptInfo.lastRun) ptNow = '⚪ 未在试玩 · 最近一局 ' + hms(ptInfo.lastRun.startedAt) + '（时长 ' + durText(ptInfo.lastRun.durationSec) + '）';
        else ptNow = '⚪ 未在试玩（这次游戏会话里还没开过局）';

        var ptRows = [];
        ptRows = ptRows.concat(cell('现在', ptNow, 'pt'));
        if (ptInfo && ptInfo.lastRun && ptInfo.lastRun.endedAt) {
          ptRows = ptRows.concat(cell('最近结束', hms(ptInfo.lastRun.endedAt), 'pte'));
        }
        if (ptInfo && ptInfo.epochSec) {
          ptRows = ptRows.concat(cell('本局编号', String(ptInfo.epochSec) + '　与 .gia 的 instance 对得上号', 'ptn'));
        }
        if (ptInfo && ptInfo.logPath) {
          ptRows = ptRows.concat(cell('信号来源', basename(ptInfo.logPath) + '　实时', 'ptl'));
        }
        ptKids.push(React.createElement(KVGrid, { rows: ptRows, key: 'kv' }));

        var ptRuns = (ptInfo && ptInfo.recentRuns) || [];
        if (ptRuns.length) {
          ptKids.push(React.createElement('div', { key: 'runs' },
            ptRuns.slice().reverse().map(function (r, i) {
              return React.createElement('span', {
                className: PLUGIN + '-pill', key: 'r' + i,
                title: '开跑 ' + r.startedAt + '　时长 ' + durText(r.durationSec) + '　编号 ' + (r.epochSec || '—'),
              }, hms(r.startedAt) + '　' + durText(r.durationSec));
            })));
        }

        ptKids.push(React.createElement('div', { className: PLUGIN + '-row', key: 'auto' },
          React.createElement('button', {
            className: PLUGIN + '-act' + (autoShot ? ' ' + PLUGIN + '-primary' : ''), key: 'tg',
            title: '开着的时候：检测到「试玩开跑」→ 等 N 秒 → 自动截一张游戏画面（只截图，不碰你的脚本）',
            onClick: function () {
              var next = !autoShot;
              setAutoShot(next);
              setPtNote(next ? '已开：检测到开跑后约 ' + autoShotDelay + ' 秒自动截图' : '已关（不会再自动截图）');
            },
          }, autoShot ? '开跑自动截图：开' : '开跑自动截图：关'),
          [3, 5, 10].map(function (n) {
            return React.createElement('button', {
              className: PLUGIN + '-act', key: 'd' + n,
              style: { padding: '2px 9px', fontSize: '10.5px' },
              title: '开跑后等 ' + n + ' 秒再截（游戏刚起来的头一两秒还在加载）',
              onClick: function () { setAutoShotDelay(n); },
            }, (autoShotDelay === n ? '● ' : '') + n + ' 秒');
          }),
          React.createElement('button', {
            className: PLUGIN + '-act', key: 'now',
            title: '不等开跑，现在就截一张',
            onClick: function () { doCapture('game'); },
          }, '立刻截')));

        if (ptNote) {
          ptKids.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'note' }, plain(ptNote)));
        }
        ptKids.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'why' },
          React.createElement('div', null, plain('开跑/结束读的是游戏自己写的 output_log.txt（每行带毫秒时间戳）——'
            + '实测「它写下」到「我们读到」只差 0.07~0.18 秒，所以能做「开跑 N 秒后」这种触发。')),
          React.createElement('div', { style: { marginTop: '3px' } },
            plain('⚠️ 不能用 .gia 判开跑：它是这一局**结束之后**才落盘的'
              + '（实测 21:46:58 结束、21:47:07 才出现）—— 局在跑的时候磁盘上根本没有这个文件。'))));

        var col3 = [
          sec('试玩开跑', ptLive ? '试玩中 · ' + durText(ptInfo.elapsedSec) : '等开跑',
            ptKids, 'secPt', ptLive ? 'ok' : 'warn'),
          sec('运行时日志', '读 .gia', logKids, 'secL', 'ok'),
          sec('游戏截图', shotInfo ? ((shotInfo.count || 0) + ' 张 · 记得清理') : '把画面存成 PNG',
            shotKids, 'secShot', shotInfo && shotInfo.count ? 'ok' : 'warn'),
          /*
           * 「高级诊断」折叠卡片：试玩探针**默认收起**。
           * 作者的原话：「折腾试玩探针对人没啥用啊」—— 他是对的：试玩探针解决的是「我写代码时不知道某件事」
           * 这种 AI 侧的问题，而创作者要为它付出四次手工操作。所以降级成折叠区，
           * 并且把「这是给 AI 用的」直接写在标题上，而不是等用户点开才明白。
           */
          /*
           * 「高级诊断」折叠卡片，里面两块**风险完全不同**，所以要分开标：
           *   ① 读界面控件 —— **只读**（从 .gil 读），不会碰你的脚本，作者自己也能用
           *   ② 试玩探针 —— 会**临时覆盖**活文件，主要给 AI 排障用
           * 作者的原话：「折腾试玩探针对人没啥用啊」+「关键 ui 读取……做到高级功能里面做个样子」。
           */
          React.createElement('div', { className: PLUGIN + '-sec', key: 'secAdv' },
            React.createElement('div', {
              className: PLUGIN + '-fold-title',
              key: 'ft',
              title: '点一下' + (advOpen ? '收起' : '展开'),
              onClick: function () { setAdvOpen(!advOpen); },
            },
              React.createElement('span', { className: PLUGIN + '-dot warn' }),
              '高级诊断（读界面控件 / 试玩探针）',
              React.createElement('span', { className: PLUGIN + '-onlyai' }, advOpen ? '' : '平时不用展开'),
              React.createElement('span', { className: PLUGIN + '-hint' }, advOpen ? '▾' : '▸')),
            React.createElement('div', { className: PLUGIN + '-hint' }, advOpen
              ? '① 读界面控件是只读的（从地图存档读，不碰任何文件）；② 试玩探针会临时覆盖你的脚本。'
              : '平时不用展开。里面「读界面控件」是只读安全的；「试玩探针」会临时覆盖你的脚本。'),
            advOpen
              ? React.createElement('div', null,
                React.createElement('div', { className: PLUGIN + '-hint', style: { marginTop: '2px', fontWeight: 600, color: '#7dd3fc' } },
                  '① 读界面控件（只读 · 不改任何文件）'),
                React.createElement('div', null, uiKids),
                React.createElement('div', { className: PLUGIN + '-hint', style: { marginTop: '8px', fontWeight: 600, color: '#f9a8d4' } },
                  '② 试玩探针（⚠️ 会临时覆盖你的脚本 —— 主要给 AI 排障用）'),
                React.createElement('div', null, probeKids))
              : null),
        ];

        var kids = [
          React.createElement('div', {
            className: PLUGIN + '-head', key: 'head',
            onMouseDown: onHeadDown, onDoubleClick: onHeadDouble,
            title: '按住这里可以拖动面板；双击回到原位（右下角拖拽改尺寸）',
          },
            React.createElement(Icon, { k: 'mk' }),
            React.createElement('span', { className: PLUGIN + '-title', key: 'ti' }, 'Miliastra Wonderland'),
            React.createElement('span', { className: PLUGIN + '-badge', key: 'bg' }, '千星奇域'),
            verNow ? React.createElement('span', {
              className: PLUGIN + '-badge', key: 'ver', style: { fontWeight: 600 },
              title: '当前插件版本（来自 Host —— Host 是启动快照；源码比它新时下面那行会提示重启 dsh web）',
            }, 'v' + verNow) : null,
            update && update.newer ? React.createElement('button', {
              className: PLUGIN + '-act', key: 'upd',
              onClick: function () { window.open('https://github.com/LoktLin/dsh-miliastra/releases', '_blank', 'noopener'); },
              style: { background: '#dc2626', borderColor: '#dc2626', color: '#fff', fontWeight: 700, padding: '3px 10px', fontSize: '11.5px' },
              title: 'GitHub 上最新 tag 是 v' + update.latest + '，本地是 v' + update.cur + ' —— 点开 release 页（打开面板时查的）',
            }, '插件有更新 → v' + update.latest) : null,
            update && update.error && !update.newer ? React.createElement('span', {
              className: PLUGIN + '-note', key: 'updErr', style: { margin: 0, fontSize: 11, opacity: 0.75 },
              title: 'GitHub 查询失败：' + update.error + ' —— **这不代表"已是最新"**，只代表没查到（离线/超时/被拦）',
            }, '版本没查到') : null,
            React.createElement('span', { className: PLUGIN + '-spacer', key: 'sp' }),
            React.createElement('button', {
              className: PLUGIN + '-act', onClick: function () { load(false); }, disabled: busy, key: 'rf',
              style: { padding: '3px 10px', fontSize: '11.5px' },
            }, busy ? '刷新中…' : '刷新'),
            inline ? null : React.createElement('button', {
              className: PLUGIN + '-pin' + (pinned ? ' ' + PLUGIN + '-pin-on' : ''), key: 'pin',
              onClick: function () { setPinned(!pinned); },
              title: pinned
                ? '常驻：点面板外面不会关（再点一下就恢复"点外面关闭"）—— 这个开关会记住'
                : '现在"点面板外面就关"。点一下变常驻 ⇒ 面板一直停在旁边，刷新页面也还在',
            }, pinned ? '📌 常驻' : '📌 不常驻'),
            inline ? null : React.createElement('button', { className: PLUGIN + '-x', onClick: function () { setOpen(false); }, title: '关闭', key: 'x' }, '×')),
        ];
        if (err) kids.push(React.createElement('div', { className: PLUGIN + '-err', key: 'err', style: { margin: '9px 13px 0' } }, String(err)));
        if (note) kids.push(React.createElement('div', { className: PLUGIN + '-note', key: 'note', style: { margin: '9px 13px 0' } }, String(note)));
        /*
         * 版本行：**Host 是启动时的快照** —— 源码比它新就当场说，别让人去推理。
         * （2026-09-23 深夜真踩：源码 22:41 改到 0.0.9，Host 还报 0.0.5，定位花掉 5 个调用。）
         * 正常时是灰字一行；**陈旧时才变琥珀色并带上「重启 dsh web」的下一步**。
         */
        if (status && status.version) {
          var srcInfo = status.source || {};
          var stale = !!srcInfo.stale;
          var bits = ['Host v' + status.version];
          if (status.startedAt) {
            var sd = new Date(status.startedAt);
            if (!isNaN(sd.getTime())) {
              bits.push('启动 ' + ('0' + sd.getHours()).slice(-2) + ':' + ('0' + sd.getMinutes()).slice(-2));
            }
          }
          if (srcInfo.sourceVersion) bits.push('源码 v' + srcInfo.sourceVersion);
          var verStyle = { margin: '9px 13px 0' };
          if (stale) { verStyle.color = '#fbbf24'; verStyle.fontWeight = 600; }
          kids.push(React.createElement('div', { className: PLUGIN + '-note', key: 'ver', style: verStyle },
            (stale ? '⚠️ ' : '') + bits.join(' · ') + (stale && srcInfo.hint ? ' —— ' + srcInfo.hint : '')));
        }
        var shownGroup = inline ? group : panelTab;
        var bodyCols = [];
        if (shownGroup === 'all' || shownGroup === 'basic') {
          bodyCols.push(col('① 关卡', col1, 'c1'));
          bodyCols.push(col('② 代码', col2, 'c2'));
        }
        if (shownGroup === 'all' || shownGroup === 'advanced') bodyCols.push(col('③ 日志与画面', col3, 'c3'));

        /*
         * ★ 第四页「预制效果」（2026-09-30 作者要求）：**与模拟器页同布局 1:2** ——
         *   左 1 = 预制效果下拉 + 细节调试（发射器属性的**可覆盖项**）+ 「一键复制」「预览」；
         *   右 2 = 模拟器（`GET /miliastra/play`，与 AI 的 miliastra_sim 同一个会话）。
         *   ⚠️ 面板里的改动**只作用于这一次生成**（临时覆盖），**不写回预设库** —— 按作者选的 (a)。
         *   ⚠️ 只做"看与预览"：**没有**「一键投到活文件」按钮（改关卡必须走工具、由人决定）。
         */
        /*
         * ⚠️ 2026-09-30 踩过的两个坑（作者现场看到"一直刷新 + tab 跑到下面"）：
         *   ① **组件定义不能每次 render 都新建** —— 直接 `function PresetsPane()` 会让每次 render 的
         *      **元素类型都不同** ⇒ React 卸载重挂 ⇒ 里面的 `iframe` 反复重载（"一直刷新"）。
         *      这里把函数缓存在工厂作用域的 `exports` 上（同 `__testUnwrapToolResult` 的用法），身份稳定；
         *      ⚠️ **不用 `useRef`** —— `react-hooks/rules-of-hooks` 会判它"条件式调用"（lint 实测拦下）。
         *   ② 渲染必须插在 **tab 条之后**的正文分支里（插到前面会把头部顶出去、tab 条被挤到底部）。
         */
        if (!exports.__presetsPane) exports.__presetsPane = function PresetsPane() {
          var g1 = React.useState(PRESETS_UI.map(function (p) { return { id: p[0], nameZh: p[1], needsImageId: p[2] }; })); var list = g1[0]; var setList = g1[1];
          var g2 = React.useState(''); var pid = g2[0]; var setPid = g2[1];
          var g3 = React.useState({ imageId: '', duration: '', sizeScale: '', particlesPerEmitter: '', templateIndex: '', container: '', parentName: '' });
          var ov = g3[0]; var setOv = g3[1];
          var g4 = React.useState(null); var gen = g4[0]; var setGen = g4[1];
          var g5 = React.useState(''); var msg = g5[0]; var setMsg = g5[1];
          var g6 = React.useState(false); var busy = g6[0]; var setBusy = g6[1];
          var g7 = React.useState(null); var prev = g7[0]; var setPrev = g7[1];
          /* ★ 每次**成功预览**后 +1，用来强制 iframe 重挂 ⇒ 让新工程真的显示出来（"切换不行"的第二半原因） */
          var g8 = React.useState(0); var playNonce = g8[0]; var setPlayNonce = g8[1];
          React.useEffect(function () {
            /* ★ 默认预设也要**自动展示**（2026-09-30 作者截图：下拉/交接值都好了，右边还是占位 ——
             *   因为自动选中的默认预设不会触发 onChange ⇒ 没人去投递）。这里做一次协调：
             *   取清单与读交接值两个请求**都**回来之后，自动跑一次 生成+预览，页面立刻有画面。 */
            /*
             * ★ 默认 id **直接给值**，不等"取清单"（2026-09-30 实测：交接值填上了、但 msg 一行都没有 ⇒
             *   取清单那次调用没把结果交回来，而自动预览原先在**等两个都回来** ⇒ 一直不触发）。
             *   静态表里第一项就是 `star-scatter`，直接用它是安全的（它不需要图片号）。
             */
            var autoId = 'star-scatter'; var autoOv = null;
            var maybeAuto = function () { /* 自动投递已移除（2026-09-30）：打开面板时不再偷偷跑生成+预览 —— 它一旦卡住完全看不出原因；改回用户点「预览（投进模拟器）」 */ };
            callTool('miliastra_gen', { op: 'vfx-lua', preset: 'list', summaryOnly: true }).then(function (r) {
              if (r && r.ok && Array.isArray(r.presets)) {
                setList(r.presets);
                if (!pid && r.presets[0]) setPid(r.presets[0].id);
                autoId = (r.presets[0] && r.presets[0].id) || 'star-scatter';
                maybeAuto();
              }
              else setMsg('预设清单没拿到：' + String((r && (r.error || r.needsHandover)) || '未知原因'));
            });
            /*
             * ★ 交接值**自动填**（2026-09-30 作者报"我切换了 没有变化"）：
             *   根因 = 左栏「控件模板索引 / 容器节点索引」留空 ⇒ `op=bind` **建不出控件**（它必须有 templates）
             *   ⇒ 模拟器里保持旧工程 ⇒ 看着"没变化"。**不是切换没生效，是预览根本没投进去。**
             *   ⇒ 打开面板时从**当前关卡**的 `.gil` 读候选（`op=clientui`），自动填「图片」模板 + 第一个容器。
             *   ⚠️ 换图后这些号会变（实测本机当前关卡已从 1073741838 换成 1073741839，旧号不再适用）⇒ 必须**现读**。
             */
            callTool('miliastra_map', { op: 'clientui', summaryOnly: true }).then(function (m) {
              if (!m || !m.ok) {
                setMsg('交接值没读到（' + String((m && m.error) || '未知') + '）—— 模拟器预览需要「图片」模板索引与容器节点索引，请手填。');
                return;
              }
              var tpl = (m.likelyTemplates || []).filter(function (t) { return /图片/.test(String(t.name || '')); })[0] || (m.likelyTemplates || [])[0];
              var cont = (m.likelyContainers || [])[0];
              var nextOv = Object.assign({}, ov);
              if (nextOv.templateIndex === '' && tpl) nextOv.templateIndex = String(tpl.id);
              if (nextOv.container === '' && cont) nextOv.container = String(cont.id);
              setOv(nextOv);
              autoOv = nextOv;
              maybeAuto();
              setMsg('已从本关 `.gil` 自动填交接值：图片模板 ' + (tpl ? tpl.id : '（没找到）') + ' / 容器 ' + (cont ? cont.id : '（没找到）')
                + '　⚠️ 换图后请重开面板重读；不对就手改。');
            });
          }, []);
          var args = function (idArg, ovArg) {
            var O = ovArg || ov;
            var a = { op: 'vfx-lua', preset: idArg || pid, output: 'lua' };
            ['imageId', 'duration', 'sizeScale', 'particlesPerEmitter', 'templateIndex', 'container'].forEach(function (k) {
              if (O[k] !== '' && O[k] != null) a[k] = Number(O[k]);
            });
            if (O.parentName) a.parentName = O.parentName;
            return a;
          };
          /*
           * ★ 选择即展示（2026-09-30 作者要求："为啥我选择了没有直接展示"）：
           *   选预设 ⇒ **立刻生成 + 投进模拟器预览**（不用先点两个按钮）。`alsoPreview` 就是这一路。
           */
          var doGen = function (idArg, alsoPreview, ovArg) {
            if (!(idArg || pid)) { setMsg('先选一个预设。'); return; }
            setBusy(true); setMsg(''); setPrev(null);
            callTool('miliastra_gen', args(idArg, ovArg)).then(function (r) {
              setBusy(false); setGen(r || null);
              if (alsoPreview && r && r.ok && r.lua) doPreview(r.lua, ovArg);
              if (!r || !r.ok) {
                /*
                 * 错误提示要**说人话、别叠墙**（2026-09-30 作者：啥玩意???）：
                 *   工具的原始错误本身很长（它要讲清「不猜」的立场），我上一条又在后面接了一句 ⇒ 叠成一堵墙。
                 *   这里分两条路：需图片号 ⇒ 一句可执行的话 + 候选号；其它 ⇒ 只取原始错误的**第一句**。
                 */
                var raw = String((r && (r.error || r.code)) || '未知原因');
                var looksImg = /needsImageId|imageId|贴图号|图片号/i.test(JSON.stringify(r || {}));
                var cur = (list.filter(function (x) { return x.id === pid; })[0] || {}).nameZh || pid;
                setMsg(looksImg
                  ? '「' + cur + '」需要**图片号** —— 在「图片号」里填一个再选一次。宝箱候选（识图推断、非官方命名）：111064 / 105221 / 105222。'
                  : '生成失败：' + raw.split('\n')[0].slice(0, 150));
              }
              else setMsg('已生成：' + r.luaBytes + ' B / ' + r.lines + ' 行' + (r.preflight ? ('　preflight FAIL ' + (r.preflight.filter(function (x) { return x.ok === false; }).length) + ' 项') : ''));
            });
          };
          var doCopy = function () {
            var lua = gen && gen.lua;
            if (!lua) { setMsg('先生成一次 Lua 再复制。'); return; }
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(lua).then(function () { setMsg('已复制 ' + lua.length + ' 字符到剪贴板。'); })
                .catch(function (e) { setMsg('复制失败（浏览器不给剪贴板权限）：' + String((e && e.message) || e)); });
            } else setMsg('这个环境没有 navigator.clipboard —— 请从下方正文里手动选。');
          };
          var doPreview = function (luaArg, ovArg) {
            var O = ovArg || ov;
            var lua = luaArg || (gen && gen.lua);
            if (!lua) { setMsg('先生成一次 Lua 再预览。'); return; }
            setBusy(true); setMsg('');
            callTool('miliastra_sim', {
              op: 'bind',
              scripts: [{ path: (pid || 'preset') + '.lua', source: lua }],
              templates: O.templateIndex === '' ? [] : [{ guid: Number(O.templateIndex), kind: 'image' }],
              containerId: O.container === '' ? undefined : Number(O.container),
              run: true,
            }).then(function (r) {
              setBusy(false); setPrev(r || null);
              if (r && r.ok !== false) {
                /* ⚠️ 2026-09-30 实测：**不要自动重挂 iframe** —— 它会把页面正在发的轮询请求打断
                 *    （浏览器报 `net::ERR_ABORTED` 并把红条显示出来）。改为左栏一个「重载画面」按钮，
                 *    由人决定何时刷新（预览已经投进同一个会话，通常不刷新也能看到）。 */
                setMsg('已投进模拟器工程（**没动活文件**）：控件 ' + (r.controlCount == null ? '?' : r.controlCount) + ' 个'
                  + '　画面若没变，点左栏「重载画面」。');
                /*
                 * ★ **成功后自动重挂一次**（2026-09-30 作者："现在要按预览、然后重载画面才会展示"）：
                 *   之前我不敢自动重挂 —— 那会把页面在飞的轮询打断、弹出 ERR_ABORTED 红条。
                 *   但那条红条的**真因**是"页面把没有会话当成错误"（已修：现在显示中性「● 未开始」），
                 *   所以**延迟 600ms**（等 bind 的会话落定）再重挂是安全的。
                 *   ⇒ 一次「预览」就能看到画面；手动「重载画面」仍保留作兜底。
                 */
                setTimeout(function () { setPlayNonce(function (n) { return n + 1; }); }, 600);
              } else {
                setMsg('预览失败：' + String((r && r.error) || '未知原因') + '　⚠️ 画面**不会**跟着变 —— 它保持的是**上一个成功的工程**。');
              }
            });
          };
          var field = function (key, label, ph) {
            return React.createElement('label', { className: PLUGIN + '-row', key: key, style: { display: 'flex', gap: '6px', alignItems: 'center' } },
              React.createElement('span', { style: { width: '118px', flex: '0 0 auto', fontSize: '11.5px' } }, label),
              React.createElement('input', {
                className: PLUGIN + '-inp', value: ov[key], placeholder: ph || '（用预设默认）',
                onChange: function (e) { var v = {}; Object.keys(ov).forEach(function (k) { v[k] = ov[k]; }); v[key] = e.target.value; setOv(v); },
              }));
          };
          var fails = gen && gen.ok && Array.isArray(gen.preflight) ? gen.preflight.filter(function (x) { return x.ok === false; }) : [];
          return React.createElement('div', { className: PLUGIN + '-simgrid' },
            React.createElement('div', { className: PLUGIN + '-col' },
              React.createElement('div', { className: PLUGIN + '-sec-title' }, '预制效果（13 个）'),
              React.createElement('select', {
                className: PLUGIN + '-inp', value: pid,
                onChange: function (e) {
                  var v = e.target.value;
                  setPid(v); setGen(null); setMsg('选择即生成并预览…');
                  doGen(v, true);
                },
              }, list.length ? list.map(function (p) {
                return React.createElement('option', { value: p.id, key: p.id },
                  (p.nameZh || p.id) + '（' + p.id + '）' + (p.needsImageId ? ' · 需图片号' : ''));
              }) : React.createElement('option', { value: '' }, '（正在取清单…）')),
              React.createElement('div', { className: PLUGIN + '-sec-title', style: { marginTop: '8px' } }, '细节调试（只作用于这一次生成）'),
              field('imageId', '图片号 imageId', '如 103050 宝剑 / 100005 五角星'),
              field('duration', '时长 duration(s)', '如 6'),
              field('sizeScale', '尺寸倍率 sizeScale', '如 1'),
              field('particlesPerEmitter', '每层池 particlesPerEmitter', '如 84'),
              field('templateIndex', '控件模板索引 *', '交接值，如 1073741868'),
              field('container', '容器节点索引 *', '交接值，如 1073741863'),
              field('parentName', '父控件名 parentName', '如 t1_hud_status'),
              React.createElement('div', { className: PLUGIN + '-hint' },
                '★ `imageId` 真机可用**平台全部 1543 个号**（用 `miliastra_asset op=icon-search` 找）；模拟器只画 100001~100006。'),
              React.createElement('div', { style: { display: 'flex', gap: '6px', marginTop: '6px', flexWrap: 'wrap' } },
                React.createElement('button', { className: PLUGIN + '-act', onClick: doGen, disabled: busy }, busy ? '处理中…' : '生成 Lua'),
                React.createElement('button', { className: PLUGIN + '-act', onClick: doCopy, disabled: !gen || !gen.ok }, '一键复制'),
                React.createElement('button', { className: PLUGIN + '-act', onClick: doPreview, disabled: !gen || !gen.ok || busy }, '预览（投进模拟器）'),
                React.createElement('button', {
                  className: PLUGIN + '-act',
                  onClick: function () { setPlayNonce(function (n) { return n + 1; }); },
                  title: '强制重新加载右边那块试玩画面（切换预设后画面没变时才点它 —— 自动重挂会打断请求并弹出红条）',
                }, '重载画面')),
              msg ? React.createElement('div', { className: PLUGIN + '-note', style: { margin: '8px 0 0' } }, msg) : null,
              fails.length ? React.createElement('div', { className: PLUGIN + '-err', style: { margin: '8px 0 0' } },
                'preflight FAIL：' + fails.map(function (f) { return f.item; }).join('；')) : null,
              gen && gen.ok && gen.preflight ? React.createElement('details', { style: { marginTop: '6px' } },
                React.createElement('summary', null, 'preflight 全 ' + gen.preflight.length + ' 项'),
                React.createElement('div', { className: PLUGIN + '-log', style: { maxHeight: '160px' } },
                  gen.preflight.map(function (f, i) {
                    return React.createElement('div', { key: i }, (f.ok === true ? '✅ ' : f.ok === false ? '❌ ' : '⚪ ') + f.item + ' — ' + f.why);
                  }))) : null),
            React.createElement('div', { className: PLUGIN + '-playside' },
              React.createElement('div', { className: PLUGIN + '-sec-title' }, '模拟器（与 AI 的 miliastra_sim 同一个会话）'),
              /*
               * ★ 完整试玩页（作者要求"放出来"，已撤回 44px 裁切）；
               * ★★ 但**只在已经有会话时才挂 iframe**（2026-09-30 从头梳理的结论，证据是 curl 拿到的原文）：
               *   实测 `POST /miliastra/engine {"op":"play","action":"get"}` 在**没有会话**时回
               *   `{"ok":false,"error":"play session has not started"}` —— 页面把它当错误显示成「出错」红条，
               *   而它其实只是"你还没投任何效果进来"。⇒ 没预览成功前先给**占位**，别让试玩页带着错误态启动。
               */
              /*
               * ★ **无条件挂试玩页**（2026-09-30 作者："之前还能加载，现在不行"）。
               *   我曾加过"没预览成功就不挂 iframe"的闸门 —— 结果**自己把自己锁死**：
               *   预览一旦卡住 ⇒ 页面永远不挂 ⇒ 右栏什么都没有（以前无条件挂、所以能加载）。
               *   页面对"没有会话"已是**中性态**（「● 未开始」），无条件挂是安全的。
               */
              React.createElement('iframe', {
                className: PLUGIN + '-playframe',
                key: 'play' + playNonce,
                src: PREFIX + '/play',
                title: '千星模拟器试玩页（完整页面）',
              }),
              prev && prev.ok ? React.createElement('div', { className: PLUGIN + '-note', style: { margin: '6px 0 0' } },
                '预览回执：控件 ' + (prev.controlCount == null ? '?' : prev.controlCount) + ' 个' + (prev.logs ? ('，日志 ' + prev.logs.length + ' 条') : '')) : null));
        };
        var PresetsPane = exports.__presetsPane;

        /*
         * ★ 第五页「像素画」（2026-09-30 作者要求，逻辑**就三步**）：
         *   ① 读**绝对路径**的图片 ② `miliastra_gen op=pixel-art` 生成 Lua ③ 立刻 `miliastra_sim op=bind` 投进同一个会话。
         *   右栏**一直挂着试玩页**（与第三/第四页同源）⇒ 生成完就有画面，不需要人再点别的。
         */
        if (!exports.__pixelPane) exports.__pixelPane = function PixelPane() {
          var q1 = React.useState(''); var ipath = q1[0]; var setIpath = q1[1];
          var q2 = React.useState('32'); var colsN = q2[0]; var setColsN = q2[1];
          var q3 = React.useState('8'); var psN = q3[0]; var setPsN = q3[1];
          var q4 = React.useState(''); var tplV = q4[0]; var setTplV = q4[1];
          var q5 = React.useState(''); var conV = q5[0]; var setConV = q5[1];
          var q6 = React.useState('给一张图片的绝对路径，然后点「生成并展示」。'); var msg = q6[0]; var setMsg = q6[1];
          var q7 = React.useState(false); var busy = q7[0]; var setBusy = q7[1];
          var q8 = React.useState(0); var nonce = q8[0]; var setNonce = q8[1];
          React.useEffect(function () {
            callTool('miliastra_map', { op: 'clientui', summaryOnly: true }).then(function (m) {
              if (!m || m.ok === false) { setMsg('交接值没读到 —— 请手填「图片模板」与「容器节点」再生成。'); return; }
              var t = (m.likelyTemplates || []).filter(function (x) { return /图片/.test(String(x.name || '')); })[0] || (m.likelyTemplates || [])[0];
              var c2 = (m.likelyContainers || [])[0];
              if (t) setTplV(String(t.id));
              if (c2) setConV(String(c2.id));
              setMsg('已从本关 .gil 现读交接值：图片模板 ' + (t ? t.id : '（没找到）') + ' / 容器 ' + (c2 ? c2.id : '（没找到）'));
            });
          }, []);
          var go = function () {
            if (!/^[A-Za-z]:[\\/]/.test(ipath)) { setMsg('请给**绝对路径**（例：C:\\Users\\你\\图片.png）—— 相对路径不读。'); return; }
            setBusy(true); setMsg('① 生成像素画 Lua …');
            callTool('miliastra_gen', { op: 'pixel-art', source: ipath, cols: Number(colsN) || 32, pixelSize: Number(psN) || 8, templateIndex: tplV ? Number(tplV) : undefined, container: conV ? Number(conV) : undefined }).then(function (r) {
              if (!r || r.ok === false) {
                setBusy(false); setMsg('生成失败：' + String((r && (r.error || JSON.stringify(r.needsHandover))) || '未知原因').split('\n')[0].slice(0, 170));
                return;
              }
              setMsg('② 已生成 ' + r.luaBytes + ' B（' + r.lines + ' 行）—— 投进模拟器 …');
              callTool('miliastra_sim', { op: 'bind', scripts: [{ path: '像素画.lua', source: r.lua }], templates: tplV ? [{ guid: Number(tplV), kind: 'image' }] : [], containerId: conV ? Number(conV) : undefined, run: true }).then(function (b) {
                setBusy(false);
                if (b && b.ok !== false) {
                  setMsg('③ 已投进模拟器：Lua ' + r.luaBytes + ' B / ' + r.lines + ' 行。右栏就是画面；没换就点「重载画面」。');
                  setTimeout(function () { setNonce(function (n) { return n + 1; }); }, 600);
                } else setMsg('生成成功，但投递失败：' + String((b && b.error) || '未知原因').slice(0, 150));
              });
            });
          };
          var row = function (label, val, set) {
            return React.createElement('label', { className: PLUGIN + '-row', key: label, style: { display: 'flex', gap: '6px', alignItems: 'center' } },
              React.createElement('span', { style: { width: '118px', flex: '0 0 auto', fontSize: '11.5px' } }, label),
              React.createElement('input', { className: PLUGIN + '-inp', value: val, onChange: function (e) { set(e.target.value); } }));
          };
          return React.createElement('div', { className: PLUGIN + '-simgrid' },
            React.createElement('div', { className: PLUGIN + '-col' },
              React.createElement('div', { className: PLUGIN + '-sec-title' }, '图片 → 像素画 Lua（绝对路径）'),
              row('图片绝对路径 *', ipath, setIpath),
              row('网格列数 cols', colsN, setColsN),
              row('像素块大小 pixelSize', psN, setPsN),
              row('图片模板索引 *', tplV, setTplV),
              row('容器节点索引 *', conV, setConV),
              React.createElement('div', { className: PLUGIN + '-hint' },
                '★ 只读**绝对路径**（不抓网图）；产物是**矩形块拼图**（行内行程 + 跨行同色同宽合并、透明格不建块），静态、不加 EnableUpdate。'),
              React.createElement('div', { style: { display: 'flex', gap: '6px', marginTop: '6px', flexWrap: 'wrap' } },
                React.createElement('button', { className: PLUGIN + '-act', onClick: go, disabled: busy }, busy ? '处理中…' : '生成并展示'),
                React.createElement('button', { className: PLUGIN + '-act', onClick: function () { setNonce(function (n) { return n + 1; }); } }, '重载画面')),
              React.createElement('div', { className: PLUGIN + '-note', style: { margin: '8px 0 0' } }, msg)),
            React.createElement('div', { className: PLUGIN + '-playside' },
              React.createElement('div', { className: PLUGIN + '-sec-title' }, '模拟器（同一个会话）'),
              React.createElement('iframe', { className: PLUGIN + '-playframe', key: 'px' + nonce, src: PREFIX + '/play', title: '千星模拟器试玩页' })));
        };
        var PixelPane = exports.__pixelPane;

        /*
         * ★ 第六页「网格计算」（2026-09-30 作者要求）：把 **1600×1000 的设计画布**按 X / Y 两个步长切格子，
         *   供**人和玩家**查坐标（放置模型时对位置）。
         *   左 = 参数（可调）+ 结论 + 两个方向的换算；右 = **可点的网格图** + 逐格速查表。
         *
         * ⚠️ 这一页**纯前端计算**：一个工具都不调、不写任何文件、不碰活文件 —— 所以它没有"失败态"，
         *    唯一可能不合法的是输入本身（那时如实报错，不静默兜底）。
         * ⚠️ 坐标口径 = **设计画布**（左上原点、y 向下），与模拟器内部舞台的左下原点**不是一回事**。
         */
        if (!exports.__gridPane) exports.__gridPane = function GridPane(props) {
          /*
           * 初值顺序：`__gridInit`（测试注入口）> **上次存的**（localStorage）> 默认值。
           * `__gridInit` 与 `__advOpen` / `__logs` / `__uiInfo` 是同一套注入口 ——
           * 否则"除不尽那一档""多选列表"这些状态没法在无浏览器的环境里渲染出来验证。
           */
          var init = (props && props.__gridInit) || {};
          var saved = gridSaved();
          var pick = function (key, dft) {
            var v = init[key] != null ? init[key] : saved[key];
            return v == null ? dft : String(v);
          };
          var m1 = React.useState(pick('width', '1600')); var gw = m1[0]; var setGw = m1[1];
          var m2 = React.useState(pick('height', '1000')); var gh = m2[0]; var setGh = m2[1];
          var m3 = React.useState(pick('stepX', '100')); var sx = m3[0]; var setSx = m3[1];
          var m4 = React.useState(pick('stepY', '50')); var sy = m4[0]; var setSy = m4[1];
          var m5 = React.useState(pick('px', '800')); var pxv = m5[0]; var setPxv = m5[1];
          var m6 = React.useState(pick('py', '500')); var pyv = m6[0]; var setPyv = m6[1];
          var m7 = React.useState(pick('col', '0')); var cv = m7[0]; var setCv = m7[1];
          var m8 = React.useState(pick('row', '0')); var rv = m8[0]; var setRv = m8[1];
          var m9 = React.useState(''); var msg = m9[0]; var setMsg = m9[1];
          // 格内灰字标什么：**中心像素 x,y（默认）** / 格号 col,row / 不显示
          var m10 = React.useState(pick('labelMode', 'center')); var labelMode = m10[0]; var setLabelMode = m10[1];
          // 多选：`[{col,row}, …]`（点格子切换）—— 存下来，下次打开还在
          var m11 = React.useState(function () {
            return Array.isArray(init.sel) ? init.sel : (Array.isArray(saved.sel) ? saved.sel : []);
          });
          var sel = m11[0]; var setSel = m11[1];
          // 复制出去的 x,y 取哪个角：默认**右下**（作者 2026-10-01）
          var m12 = React.useState(pick('anchor', 'br')); var anchor = m12[0]; var setAnchor = m12[1];
          // 网格图缩放（滚轮；只缩图，不缩面板）
          var m13 = React.useState(function () {
            var z = Number(init.zoom != null ? init.zoom : saved.zoom);
            return isFinite(z) && z > 0 ? z : 1;
          });
          var zoom = m13[0]; var setZoom = m13[1];
          // 右键标记的颜色：`{'col,row': 色id}` + 当前笔刷（默认第一个 = 灰）
          var m14 = React.useState(function () {
            var v = init.colors != null ? init.colors : saved.colors;
            return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
          });
          var colors = m14[0]; var setColors = m14[1];
          var m15 = React.useState(pick('brush', 'gray')); var brush = m15[0]; var setBrush = m15[1];
          var zoomRef = React.useRef(zoom);
          zoomRef.current = zoom;
          var gridBoxRef = React.useRef(null);
          // 左键按住拖动（放大后平移）：拖过就把随后的那次 click 吃掉（否则会顺手选中一格）
          var panRef = React.useRef(null);
          var panOn = React.useState(false); var panning = panOn[0]; var setPanning = panOn[1];
          var suppressClick = React.useRef(false);
          var storeWarned = React.useRef(false);

          var plan = gridPlan({ width: gw, height: gh, stepX: sx, stepY: sy });
          var pInfo = plan.ok ? gridPixelToCell(plan, pxv, pyv) : null;
          var cInfo = plan.ok ? gridCellToPixel(plan, cv, rv) : null;
          var lines = plan.ok ? gridLines(plan) : null;
          var labels = plan.ok ? gridLabels(plan, labelMode, anchor) : null;
          // 选中集合 → 逐行数据（按当前网格算 + 按选定的角取 x,y + 带上右键标记的颜色；
          // 网格改小后失效的那几行**留着重说**，不静默丢）
          var selRows = gridSelRows(plan, sel, anchor, colors);
          var selOkRows = selRows.filter(function (r) { return r.ok; });
          var selBadRows = selRows.filter(function (r) { return !r.ok; });
          var selKeys = {};
          selRows.forEach(function (r) { if (r.ok) selKeys[gridSelKey(r.col, r.row)] = true; });

          /*
           * 存下来（作者：「网格计算的值能缓存下，我不想每次打开都要重新输入」）。
           * ⚠️ 存不下（隐私模式 / 配额满 / 被禁）就**说一次**，不静默 —— 否则人会以为"下次还在"。
           */
          React.useEffect(function () {
            var snap = {
              width: gw, height: gh, stepX: sx, stepY: sy, px: pxv, py: pyv,
              col: cv, row: rv, labelMode: labelMode, sel: sel, anchor: anchor, zoom: zoom,
              colors: colors, brush: brush,
            };
            var okSaved = storeSet(GRID_STORE_KEY, snap);
            gridStoreCache = snap;
            if (!okSaved && !storeWarned.current) {
              storeWarned.current = true;
              setMsg('这些值这次没能存到浏览器里（localStorage 不可用或被禁）—— 刷新页面后要重新填。');
            }
          }, [gw, gh, sx, sy, pxv, pyv, cv, rv, labelMode, sel, anchor, zoom, colors, brush]);

          /*
           * ★ 滚轮缩放**只作用在网格图**（作者 2026-10-01），不动面板本身。
           * ⚠️ 必须用**原生非 passive 监听**：React 的 `onWheel` 是挂在根上的 passive 监听，
           *   里面 `preventDefault()` 不生效（浏览器会警告），面板会跟着一起滚。
           *   所以这里 `addEventListener('wheel', fn, {passive:false})` —— 只这一处需要。
           */
          React.useEffect(function () {
            var el = gridBoxRef.current;
            if (!el) return undefined;
            var onWheel = function (e) {
              e.preventDefault();
              var step = e.deltaY < 0 ? 1.12 : (1 / 1.12);
              var z = Math.round(gridZoomClamp(zoomRef.current * step) * 1000) / 1000;
              setZoom(z);
            };
            el.addEventListener('wheel', onWheel, { passive: false });
            return function () { el.removeEventListener('wheel', onWheel); };
          }, [plan.ok]);

          var copy = function (text, what) {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(text).then(function () {
                var ls = text.split('\n');
                setMsg('已复制' + what + '：' + ls[0].slice(0, 90) + (ls.length > 1 ? ' …（共 ' + ls.length + ' 行）' : ''));
              }).catch(function (e) { setMsg('复制失败（浏览器不给剪贴板权限）：' + String((e && e.message) || e)); });
            } else setMsg('这个环境没有 navigator.clipboard —— 请从下面的结论里手动选。');
          };

          /*
           * 点网格图取坐标。线性换算成立的前提是**盒子比例 == viewBox 比例** ——
           * CSS 里 `-gridsvg` 是 `width:100%;height:auto`（比例由 viewBox 决定），加上
           * `preserveAspectRatio:"none"`，所以盒子里没有留白、可以直接按比例算。
           * ⚠️ 画布 y **向下** = 屏幕 y 向下，所以这里**不翻转**（翻转那是引擎左下原点那套）。
           *
           * ★ 留在格内 ⇒ **吸附到该格中心**，并把这一格**切换进/出选中集合**（多选）；
           *   留在**残格 / 画布外** ⇒ 不吸附（照实填那个点），这样"界外"这条判定能被亲眼看到。
           */
          /** 事件 → 落在哪一格（用 SVG 自己的盒子换算，所以**缩放/平移都不影响**）。 */
          var cellAtEvent = function (e) {
            if (!plan.ok) return null;
            try {
              var el = e.currentTarget || e.target;
              var box = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
              if (!box || !box.width || !box.height) return null;
              var x = Math.round((e.clientX - box.left) * plan.width / box.width);
              var y = Math.round((e.clientY - box.top) * plan.height / box.height);
              var hit = gridPixelToCell(plan, x, y);
              return hit.ok && hit.inGrid ? hit.cell : null;
            } catch (err) { return null; }
          };

          /*
           * ★ 左键按住拖动 = 平移（作者 2026-10-01：「网格图 放大后我希望能左键按住拖动」）。
           * 与"点一格 = 选中/取消"共存的办法：**移动超过 3px 才算拖**，拖过之后把随后那次 `click` 吃掉
           * （`suppressClick`），否则拖完手一松就顺手选/取消了一格 —— 那正是"怎么老是多一格"的来源。
           * 平移改的是 `gridBoxRef` 的 `scrollLeft/scrollTop`（滚轮缩放负责放大，盒子负责看哪儿）。
           */
          var onGridDown = function (e) {
            if (!plan.ok || e.button !== 0) return;
            var el = gridBoxRef.current;
            if (!el) return;
            /*
             * ⚠️ 每次按下先把「吃掉那次 click」的清零。
             * 不这么做就有个真实的坑：**在图上拖完、把鼠标松在格子外面** ⇒ `click` 不会打到 SVG，
             * 那个标记就一直留着 ⇒ **下一次真正的点击会被白吃掉一次**（表现为"第一下点了没反应"）。
             */
            suppressClick.current = false;
            panRef.current = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop, moved: false };
            setPanning(true);
            e.preventDefault();   // 免得拖出文字选区 / 图片拖影
          };
          React.useEffect(function () {
            if (!panning) return undefined;
            var move = function (e) {
              var d = panRef.current;
              var el = gridBoxRef.current;
              if (!d || !el) return;
              var dx = e.clientX - d.x, dy = e.clientY - d.y;
              if (!d.moved && Math.abs(dx) + Math.abs(dy) < 3) return;   // 3px 以内当点击
              d.moved = true;
              el.scrollLeft = d.sl - dx;
              el.scrollTop = d.st - dy;
            };
            var up = function () {
              var d = panRef.current;
              if (d && d.moved) suppressClick.current = true;
              panRef.current = null;
              setPanning(false);
            };
            window.addEventListener('mousemove', move);
            window.addEventListener('mouseup', up);
            return function () {
              window.removeEventListener('mousemove', move);
              window.removeEventListener('mouseup', up);
            };
          }, [panning]);

          /** 右键 = 用当前笔刷**标记/取消**颜色（作者：「网格图然后右键标记颜色」）。 */
          var onGridContext = function (e) {
            e.preventDefault();
            var cell = cellAtEvent(e);
            if (!cell) return;
            setColors(function (cur) { return gridColorToggle(cur, cell.col, cell.row, brush); });
            /*
             * 标记过的格**顺手选上**（不然导出列表里看不到它）。
             * ⚠️ 这里必须用 **`gridSelAdd`（只加不减）** 而不是 toggle ——
             *   用 toggle 的话，"给一个已经选中的格标颜色"会把它**踢出**选中列表 ⇒
             *   列表变空、复制按钮变灰（作者 2026-10-01 报的 bug）。
             */
            setSel(function (cur) { return gridSelAdd(cur, cell.col, cell.row); });
          };

          var onGridClick = function (e) {
            if (!plan.ok) return;
            if (suppressClick.current) { suppressClick.current = false; return; }   // 刚才是拖动，不是点击
            try {
              var r = e.currentTarget.getBoundingClientRect();
              if (!r.width || !r.height) return;
              var x = Math.round((e.clientX - r.left) * plan.width / r.width);
              var y = Math.round((e.clientY - r.top) * plan.height / r.height);
              // 夹到 [0, 画布边] —— 夹到 width-1 就点不到右边/下边那条残格，那正是要给人看的
              x = Math.max(0, Math.min(plan.width, x));
              y = Math.max(0, Math.min(plan.height, y));
              var hit = gridPixelToCell(plan, x, y);
              if (hit.ok && hit.inGrid && hit.cell) {
                setPxv(String(hit.cell.cx));
                setPyv(String(hit.cell.cy));
                setCv(String(hit.cell.col));
                setRv(String(hit.cell.row));
                setSel(function (cur) { return gridSelToggle(cur, hit.cell.col, hit.cell.row); });
              } else {
                setPxv(String(x));
                setPyv(String(y));
              }
            } catch (err) { setMsg('取点击位置失败：' + String((err && err.message) || err)); }
          };

          var copyCell = function (row, idx) {
            if (!row || !row.ok) { setMsg('这一格现在没有对应格（' + ((row && row.error) || '未知原因') + '），复制不了。'); return; }
            copy(gridSelLua([row]), '第 ' + (idx + 1) + ' 个');
          };
          var copyAllCells = function () {
            if (!selOkRows.length) { setMsg('还没选中任何格：在图上点一下格子（可多点几个）。'); return; }
            copy(gridSelLua(selOkRows), selOkRows.length + ' 格（x,y 列表）');
          };

          var inp = function (label, val, set) {
            return React.createElement('label', { className: PLUGIN + '-row', key: label, style: { display: 'flex', gap: '6px', alignItems: 'center' } },
              React.createElement('span', { style: { width: '118px', flex: '0 0 auto', fontSize: '11.5px' } }, label),
              React.createElement('input', { className: PLUGIN + '-inp', value: val, onChange: function (e) { set(e.target.value); } }));
          };
          var block = function (linesArr) {
            // 结论**字体放大**（作者 2026-10-01）：单独一个类，不跟着 `-log` 的 10.5px 小字走
            return React.createElement('div', { className: PLUGIN + '-gridsum', style: { marginTop: '4px' } },
              linesArr.map(function (l, i) { return React.createElement('div', { key: i }, l); }));
          };

          /* —— 右栏：网格图 —— */
          var svgKids = [];
          if (plan.ok) {
            svgKids.push(React.createElement('rect', {
              key: 'bg', x: 0, y: 0, width: plan.width, height: plan.height,
              fill: 'rgba(4,10,20,.55)', stroke: 'rgba(125,211,252,.45)', strokeWidth: 2,
            }));
            // 残格：切成两块的琥珀区（网格切不到的那一条）
            if (plan.restX > 0) svgKids.push(React.createElement('rect', {
              key: 'rx', x: plan.coverX, y: 0, width: plan.restX, height: plan.height, fill: 'rgba(251,191,36,.22)',
            }));
            if (plan.restY > 0) svgKids.push(React.createElement('rect', {
              key: 'ry', x: 0, y: plan.coverY, width: plan.width, height: plan.restY, fill: 'rgba(251,191,36,.22)',
            }));
            if (lines && lines.d) svgKids.push(React.createElement('path', {
              key: 'ln', d: lines.d, fill: 'none', stroke: 'rgba(125,211,252,.30)', strokeWidth: 1,
              vectorEffect: 'non-scaling-stroke',
            }));
            // 右键标记的颜色块（画在格线之上、选中粉块之下）：一眼看出哪些格"被分类"了
            Object.keys(colors || {}).forEach(function (k) {
              var parts = String(k).split(',');
              var mc = Number(parts[0]), mr = Number(parts[1]);
              var info = gridColorById(colors[k]);
              var cell = gridCellToPixel(plan, mc, mr);
              if (!info || !cell.ok) return;
              svgKids.push(React.createElement('rect', {
                key: 'mc' + k, x: cell.x0, y: cell.y0, width: plan.stepX, height: plan.stepY,
                fill: info.hex, fillOpacity: 0.45,
              }));
            });
            // 选中的格（**可多选**）：一格格粉块高亮 —— 这是"我挑了哪几格"的唯一落点
            selRows.forEach(function (r) {
              if (!r.ok) return;
              svgKids.push(React.createElement('rect', {
                key: 'hs' + r.col + '_' + r.row, x: r.x0, y: r.y0, width: plan.stepX, height: plan.stepY,
                fill: 'rgba(249,168,212,.35)', stroke: '#f9a8d4', strokeWidth: 2, vectorEffect: 'non-scaling-stroke',
              }));
            });
            /*
             * 格内灰字坐标（"经纬度"）：**画在高亮之后**，否则选中那一格的标签会被粉块压住。
             * ★ 选中的那些格，标签改**亮粉色加粗**，跟灰字区分开。
             * `pointerEvents:'none'` ⇒ 点标签也等于点图（不会因为戳到文字就没反应）。
             */
            if (labels && labels.items.length) {
              svgKids.push(React.createElement('g', {
                key: 'lb', pointerEvents: 'none', fill: '#8fa6c4', fontSize: labels.fontSize,
                textAnchor: 'middle', dominantBaseline: 'central',
                fontFamily: 'ui-monospace,Consolas,monospace',
              }, labels.items.map(function (it) {
                var on = !!selKeys[gridSelKey(it.col, it.row)];
                return React.createElement('text', {
                  key: it.col + '_' + it.row, x: it.x, y: it.y,
                  fill: on ? '#ffd6ec' : '#8fa6c4', fontWeight: on ? 700 : 400,
                }, it.text);
              })));
            }
            /*
             * 界外的点（残格 / 画布外）**没有格子可以高亮** —— 那就把"点在哪"画出来：
             * 否则图上什么都不动，人会以为"点了没反应"。画布外的点画出去会被 viewBox 裁掉（这也是诚实的）。
             */
            if (pInfo && pInfo.ok && !pInfo.inGrid) svgKids.push(React.createElement('circle', {
              key: 'mk', cx: pInfo.px, cy: pInfo.py, r: Math.max(6, Math.min(plan.stepX, plan.stepY) * 0.3),
              fill: 'none', stroke: '#fbbf24', strokeWidth: 2, vectorEffect: 'non-scaling-stroke',
            }));
          }

          var pane = [];
          if (!plan.ok) {
            pane.push(React.createElement('div', { className: PLUGIN + '-err', key: 'bad' }, plan.error));
          } else {
            /*
             * 网格图放在一个**自己的滚动盒子**里（作者 2026-10-01：「网格图改成可以单独滚轮缩放」）：
             * 滚轮只缩这张图（原生非 passive 监听，见上面那个 effect），**面板不跟着滚**；
             * 放大后用盒子的滚动条平移。⚠️ `width` 走 inline（`zoom*100%`），CSS 里那个 `width:100%` 只兜底。
             */
            pane.push(React.createElement('div', { className: PLUGIN + '-gridbox' + (panning ? ' ' + PLUGIN + '-panning' : ''), key: 'box', ref: gridBoxRef },
              React.createElement('svg', {
                className: PLUGIN + '-gridsvg', key: 'svg',
                viewBox: '0 0 ' + gridNum(plan.width) + ' ' + gridNum(plan.height),
                preserveAspectRatio: 'none', onClick: onGridClick, onMouseDown: onGridDown, onContextMenu: onGridContext,
                title: '左键点格=选中/取消；放大后左键按住拖动=平移；右键=标记颜色',
                style: { width: (Math.round(zoom * 10000) / 100) + '%' },
              }, svgKids)));
            /*
             * 格内标 + 缩放读数。★ 2026-10-01（作者）：「网格图的 xy 应该要和 取哪一角 联动」——
             * 所以「坐标 x,y」这一档**显示的就是当前那个角的坐标**（下拉在下面「选中的格」那一行），
             * 按钮名字里把当前角写出来，免得人还以为它永远是中心。
             */
            pane.push(React.createElement('div', { className: PLUGIN + '-chips', key: 'lbm' },
              [['center', '坐标 x,y（' + gridAnchorName(anchor) + '）'], ['cell', '格号 col,row'], ['off', '不显示']].map(function (p) {
                return React.createElement('button', {
                  key: p[0],
                  className: PLUGIN + '-act' + (labelMode === p[0] ? ' ' + PLUGIN + '-vtab-on' : ''),
                  title: p[0] === 'center' ? '格内灰字写这一格的哪个点 —— 跟下面「取哪一角」联动（现在是' + gridAnchorName(anchor) + '）' : '',
                  onClick: function () { setLabelMode(p[0]); },
                }, p[1]);
              }),
              React.createElement('button', {
                key: 'zoom',
                className: PLUGIN + '-act',
                title: '图上滚轮缩放；点这里回到 100%',
                onClick: function () { setZoom(1); },
              }, '缩放 ' + Math.round(zoom * 100) + '%')));
            /*
             * 色板（作者：「右键标记颜色…默认放几个颜色就好了」）：点一个色当笔刷，再**右键点格**上色；
             * 同一个色再右键一次 = 清除。笔刷与标记都进缓存。
             */
            pane.push(React.createElement('div', { className: PLUGIN + '-chips', key: 'pal' },
              React.createElement('span', { className: PLUGIN + '-hint', style: { alignSelf: 'center' } }, '右键标记：'),
              GRID_COLORS.map(function (c) {
                return React.createElement('button', {
                  key: c.id,
                  className: PLUGIN + '-swatch' + (brush === c.id ? ' ' + PLUGIN + '-swatch-on' : ''),
                  style: { background: c.hex },
                  title: c.name + ' ' + c.hex + (brush === c.id ? '（当前笔刷）' : '　点一下换成它'),
                  onClick: function () { setBrush(c.id); },
                }, brush === c.id ? '✓' : '');
              }),
              React.createElement('button', {
                className: PLUGIN + '-act',
                disabled: !Object.keys(colors || {}).length,
                title: '把图上所有颜色标记清掉（不影响选中）',
                onClick: function () { setColors({}); setMsg('已清除全部颜色标记。'); },
              }, '清除标记')));
            /*
             * 「当前点」那一行**只在点落空时才出**（落在格里时下面那张列表已经把它说清了）——
             * 作者 2026-10-01：「网格图的小字不要」，所以这一行不再常驻。
             */
            if (pInfo && pInfo.ok && !pInfo.inGrid) {
              pane.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'cur' }, gridPointLine(pInfo)));
            }
            // 格内标不画时**必须说清为什么**（这是"解释缺失"，不是装饰小字）
            if (labels && labels.note) {
              pane.push(React.createElement('div', { className: PLUGIN + '-hint', key: 'lbn' }, labels.note));
            }
            /*
             * ★ 多选列表（作者 2026-10-01：「网格图我希望能多选 下面要多个列表 能单独复制也能一起复制」）：
             *   每行 = 一个选中的格 + 它的 {x,y} 片段 + 「复制」「移除」；上面 = 四角下拉 + 复制全部 / 清空。
             * ⚠️ 网格改小后失效的那几行**留在列表里说清**（不静默丢、也不拿邻近格顶替），只是不参与复制。
             */
            pane.push(React.createElement('div', { className: PLUGIN + '-chips', key: 'sht', style: { marginTop: '2px' } },
              React.createElement('span', { className: PLUGIN + '-sec-title', style: { alignSelf: 'center' } },
                '选中的格（' + selOkRows.length + '）'
                + (selBadRows.length ? '　⚠️ ' + selBadRows.length + ' 个现在没有对应格' : '')),
              React.createElement('span', { className: PLUGIN + '-hint', style: { alignSelf: 'center' } }, '取哪一角：'),
              React.createElement('select', {
                className: PLUGIN + '-inp', style: { flex: '0 0 auto', width: '96px' }, value: anchor,
                title: '复制出去的 x,y 取这一格的哪个角（默认右下）',
                onChange: function (e) { setAnchor(e.target.value); },
              }, GRID_ANCHORS.map(function (a) {
                return React.createElement('option', { key: a.id, value: a.id }, a.name);
              }))));
            pane.push(React.createElement('div', { className: PLUGIN + '-row', key: 'selbtn' },
              React.createElement('button', {
                className: PLUGIN + '-act', disabled: !selOkRows.length,
                title: '把选中的格一次性复制成 x,y 列表（可直接粘进千星）',
                onClick: copyAllCells,
              }, '复制全部（x,y 列表）'),
              React.createElement('button', {
                className: PLUGIN + '-act', disabled: !selRows.length,
                onClick: function () { setSel([]); setMsg('已清空选择。'); },
              }, '清空选择'),
              // 步长改小后可能留下"现在没有对应格"的行 —— 一键清掉它们（否则那些行会一直占着列表、也复制不了）
              selBadRows.length ? React.createElement('button', {
                className: PLUGIN + '-act',
                title: '把「现在没有对应格」的那几行从选中里去掉（步长改过之后会出现）',
                onClick: function () {
                  var n = selBadRows.length;
                  setSel(function (cur) { return gridSelPrune(plan, cur); });
                  setMsg('已移除 ' + n + ' 个现在没有对应格的选中行。');
                },
              }, '移除失效行（' + selBadRows.length + '）') : null));
            if (selRows.length) {
              pane.push(React.createElement('div', { className: PLUGIN + '-log', key: 'slist', style: { maxHeight: '190px' } },
                selRows.map(function (r, i) {
                  return React.createElement('div', {
                    key: 'sr' + r.col + '_' + r.row,
                    style: { display: 'flex', gap: '6px', alignItems: 'center', padding: '1px 0' },
                  },
                  React.createElement('span', { style: { flex: '1 1 auto', minWidth: 0, whiteSpace: 'pre-wrap' } },
                    (i + 1) + '. ' + (r.ok
                      ? ('格 (' + r.col + ', ' + r.row + ')　' + r.anchorName + ' {x = ' + gridNum(r.x) + ', y = ' + gridNum(r.y) + ' '
                        + (r.color ? ',color="' + r.color + '",colorName = "' + r.colorName + '"}' : '}'))
                      : ('格 (' + r.col + ', ' + r.row + ')　⚠️ ' + r.error))),
                  React.createElement('button', {
                    className: PLUGIN + '-act', disabled: !r.ok,
                    title: '只复制这一格（同样是 {x = …, y = … } 片段）',
                    onClick: function () { copyCell(r, i); },
                  }, '复制'),
                  React.createElement('button', {
                    className: PLUGIN + '-act', title: '把这一格移出选中',
                    onClick: function () { setSel(function (cur) { return gridSelToggle(cur, r.col, r.row); }); },
                  }, '移除'));
                })));
            }
            if (lines && lines.note) {
              pane.push(React.createElement('div', { className: PLUGIN + '-note', key: 'cap' }, lines.note));
            }
            // 复制反馈就放在这一列**底下**（按钮在这一列，反馈别跑到另一列去）
            if (msg) pane.push(React.createElement('div', { className: PLUGIN + '-note', key: 'msg' }, msg));
          }

          return React.createElement('div', { className: PLUGIN + '-simgrid' },
            React.createElement('div', { className: PLUGIN + '-col' },
              React.createElement('div', { className: PLUGIN + '-sec' },
                React.createElement('div', { className: PLUGIN + '-sec-title' }, '画布与步长（可改）'),
                inp('画布宽 width', gw, setGw),
                inp('画布高 height', gh, setGh),
                inp('X 步长 stepX', sx, setSx),
                inp('Y 步长 stepY', sy, setSy),
                React.createElement('div', { className: PLUGIN + '-chips' },
                  GRID_PRESETS.map(function (p) {
                    return React.createElement('button', {
                      key: p.label, className: PLUGIN + '-act',
                      onClick: function () {
                        setGw(String(p.w)); setGh(String(p.h)); setSx(String(p.sx)); setSy(String(p.sy));
                      },
                    }, p.label);
                  })),
              React.createElement('div', { className: PLUGIN + '-sec' },
                React.createElement('div', { className: PLUGIN + '-sec-title' }, '结论'),
                block(gridSummaryLines(plan))),
              React.createElement('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
                React.createElement('button', {
                  className: PLUGIN + '-act', disabled: !plan.ok,
                  onClick: function () { copy(gridSummaryLines(plan).join('\n'), '结论'); },
                }, '复制结论'),
                React.createElement('button', {
                  className: PLUGIN + '-act',
                  title: '回到 1600×1000 / X100 Y50，并清掉多选（这些默认值同样会被缓存下来）',
                  onClick: function () {
                    setGw('1600'); setGh('1000'); setSx('100'); setSy('50');
                    setPxv('800'); setPyv('500'); setCv('0'); setRv('0');
                    setLabelMode('center'); setSel([]); setAnchor('br'); setZoom(1);
                    setColors({}); setBrush('gray'); setMsg('');
                  },
                }, '恢复默认，并清掉缓存')))),
            React.createElement('div', { className: PLUGIN + '-col' },
              React.createElement('div', { className: PLUGIN + '-sec-title' }, '网格图（点一下选中/取消这一格）'),
              pane));
        };
        var GridPane = exports.__gridPane;

        /*
         * 浮层里的三个页面：各自独立、互不干扰 —— **不再有「全部」混合页**（作者要求）。
         * 三档 = 初级功能(①②) / 高级功能(③) / 模拟器；每页内容**平铺铺满**（`-bodyfill`）。
         */
        if (!inline) {
          kids.push(React.createElement('div', { className: PLUGIN + '-viewtabs', key: 'vtabs' },
            [['basic', '初级功能'], ['advanced', '高级功能'], ['sim', '模拟器'], ['presets', '预制效果'], ['pixel', '像素画'], ['grid', '网格计算']].map(function (pair) {
              return React.createElement('button', {
                key: 'vt' + pair[0],
                className: PLUGIN + '-vtab' + (panelTab === pair[0] ? ' ' + PLUGIN + '-vtab-on' : ''),
                onClick: function () { setPanelTab(pair[0]); },
              }, pair[1]);
            })));
        }

        if (shownGroup === 'sim') {
          // 模拟器页：正文与（历史的）全宽视图同源 —— 同一份状态、同一套动作
          kids.push(React.createElement(SimulatorBody, { key: 'simbody' }));
        } else if (shownGroup === 'presets') {
          // ★ 第四页「预制效果」：**必须插在 tab 条之后**（插到前面会把头部顶出去、tab 条被挤到底部）
          kids.push(React.createElement(PresetsPane, { key: 'presets' }));
        } else if (shownGroup === 'pixel') {
          kids.push(React.createElement(PixelPane, { key: 'pixel' }));
        } else if (shownGroup === 'grid') {
          // ★ 第六页「网格计算」：同样必须插在 tab 条**之后**；`__gridInit` 是测试注入口（见 GridPane 注释）
          kids.push(React.createElement(GridPane, { key: 'grid', __gridInit: props.__gridInit }));
        } else {
          kids.push(React.createElement('div', {
            className: PLUGIN + '-body' + (shownGroup === 'all' ? '' : ' ' + PLUGIN + '-bodyfill'),
            key: 'body',
          }, bodyCols));
        }

        return React.createElement('div', {
          className: PLUGIN + '-panel' + (inline ? ' ' + PLUGIN + '-inline' : '') + (dragging ? ' ' + PLUGIN + '-dragging' : ''),
          style: panelStyle,
          ref: inline ? undefined : panelRef,
        }, kids);
      }

      /**
       * 画布点击坐标换算（**纯函数**，单独回归）。
       *
       * 语义与引擎 `engine/studio/play/browser-session.js` 的 `stagePoint` 一致：
       *   画布原点在**左下**（引擎口径），所以 y 必须翻转 `(rect.bottom - clientY)`。
       * 写错的表现是「点哪儿都点不到 / 点到别处」，而面板不会报错 —— 所以必须能测。
       *
       * ⚠️ 面板里那张**可点的画面缩略图**今天已经删了（作者：画面 GUI 不要了），
       * 但这个换算**继续保留并有独立回归**：它是"引擎左下原点坐标系"在面板侧的唯一落点，
       * 将来谁把"人可点的舞台"加回来（或挪进试玩页），判据必须是同一份。
       */
      function stagePointFromEvent(rect, width, height, clientX, clientY) {
        var r = rect || { left: 0, bottom: 0, width: 0, height: 0 };
        var w = Number(width) || 0;
        var h = Number(height) || 0;
        if (!w || !h || !r.width || !r.height) return { x: 0, y: 0 };
        return {
          x: Math.round((clientX - r.left) * w / r.width),
          y: Math.round((r.bottom - clientY) * h / r.height),
        };
      }

      /* ---------------------------------------------------------------- 网格计算（吸收 game-grid-mapper） */

      /**
       * 网格计算：把设计画布按 X / Y 两个步长切格子，供**人和玩家**查坐标（放置模型时对位置）。
       *
       * 坐标口径（与工作区技能 `game-grid-mapper` 一致，**不改**）：
       *   画布**左上 (0,0)**，x 向右增大，y 向下增大；格 (col,row) 原点在左上格，col 向右 +1、row 向下 +1；
       *   像素与业务坐标 1:1。
       * ⚠️ 这里**不做 y 翻转** —— 设计画布就是 y 向下。模拟器内部舞台那套「左下原点」（见上面
       *   `stagePointFromEvent`）是**另一层**，两者别混用。
       *
       * ★ 与旧技能的两处差别（2026-09-30 作者定）：
       *   ① **不再要求步长整除画布**。旧 `grid.py` 的 `Grid()` 不整除直接 `ValueError` 拒绝建档；
       *      现在改成如实报「残 N px」，并**把界外那一条（残格）丢掉** ——
       *      网格只覆盖 `cols*stepX × rows*stepY`，落在残格/画布外的点**不算**。
       *   ② **X / Y 步长可以不同**（旧技能只有一个正方形 `cell`）—— 作者的例子正是 X 110 / Y 80。
       *
       * 全是**纯函数**（无 React、无 DOM），所以能单独回归。
       * ⚠️ 面板**不渲染 Markdown** ⇒ 这些文案里不许出现星号加粗 / 反引号（有回归钉住）。
       */

      /** 数字 → 干净的显示串（去掉浮点尾巴）。不合法给 `?`。 */
      function gridNum(v) {
        var n = Number(v);
        if (!isFinite(n)) return '?';
        return String(Math.round(n * 1e6) / 1e6);
      }

      /** 网格参数 → 计划（纯数据）。不合法回 `{ok:false,error}`，**绝不抛**。 */
      function gridPlan(o) {
        var src = o || {};
        var width = Number(src.width), height = Number(src.height);
        var stepX = Number(src.stepX), stepY = Number(src.stepY);
        if (!isFinite(width) || !isFinite(height) || width <= 0 || height <= 0) {
          return { ok: false, error: '画布宽/高必须是正数：' + gridNum(src.width) + ' × ' + gridNum(src.height) };
        }
        if (!isFinite(stepX) || !isFinite(stepY) || stepX <= 0 || stepY <= 0) {
          return { ok: false, error: '步长必须是正数：X ' + gridNum(src.stepX) + ' / Y ' + gridNum(src.stepY) };
        }
        // +1e-9 给浮点误差兜底：0.1 这种步长不该因为 15.999999 白丢一格
        var cols = Math.floor(width / stepX + 1e-9);
        var rows = Math.floor(height / stepY + 1e-9);
        if (cols < 1 || rows < 1) {
          return { ok: false, error: '步长比画布还大（X ' + gridNum(stepX) + ' / Y ' + gridNum(stepY) + '）⇒ 一格都放不下' };
        }
        var coverX = cols * stepX, coverY = rows * stepY;
        var restX = Math.round((width - coverX) * 1e6) / 1e6;
        var restY = Math.round((height - coverY) * 1e6) / 1e6;
        return {
          ok: true,
          width: width, height: height, stepX: stepX, stepY: stepY,
          cols: cols, rows: rows, cells: cols * rows,
          coverX: coverX, coverY: coverY, restX: restX, restY: restY,
          exact: restX === 0 && restY === 0,
        };
      }

      /** 一条轴的结论：`X：1600 / 110 = 14.5455 → 14 格　残 60px ← …` */
      function gridAxisLine(plan, axis) {
        if (!plan || !plan.ok) return '';
        var isX = axis !== 'y';
        var span = isX ? plan.width : plan.height;
        var step = isX ? plan.stepX : plan.stepY;
        var n = isX ? plan.cols : plan.rows;
        var rest = isX ? plan.restX : plan.restY;
        var ratio = (Math.round((span / step) * 1e8) / 1e8).toFixed(4);
        return (isX ? 'X' : 'Y') + '：' + gridNum(span) + ' / ' + gridNum(step) + ' = ' + ratio
          + ' → ' + n + ' 格'
          + (rest === 0 ? '　整除，铺满' : '　残 ' + gridNum(rest) + 'px ← 最后一格切不出来（界外，不算）');
      }

      /** 结论若干行（给人看 / 给复制用）。参数不合法就回一行错误说明。 */
      function gridSummaryLines(plan) {
        if (!plan || !plan.ok) return ['网格参数不合法：' + ((plan && plan.error) || '未知原因')];
        var out = [
          gridAxisLine(plan, 'x'),
          gridAxisLine(plan, 'y'),
          '网格：' + plan.cols + ' × ' + plan.rows + ' = ' + plan.cells + ' 格'
            + '　有效覆盖 x[0, ' + gridNum(plan.coverX) + ') y[0, ' + gridNum(plan.coverY) + ')',
        ];
        if (plan.exact) out.push('画布铺满：没有界外。');
        else {
          var bits = [];
          if (plan.restX) bits.push('右边（x ≥ ' + gridNum(plan.coverX) + '）' + gridNum(plan.restX) + 'px');
          if (plan.restY) bits.push('下边（y ≥ ' + gridNum(plan.coverY) + '）' + gridNum(plan.restY) + 'px');
          out.push('界外不算：' + bits.join('　') + ' —— 落在里面的点直接丢掉。');
        }
        return out;
      }

      /** 格 → 像素（含该格覆盖范围与中心）。列/行越界回 `{ok:false,error}` 并说清合法范围。 */
      function gridCellToPixel(plan, col, row) {
        if (!plan || !plan.ok) return { ok: false, error: (plan && plan.error) || '网格参数不合法' };
        var c = Math.floor(Number(col)), r = Math.floor(Number(row));
        if (!isFinite(c) || !isFinite(r)) return { ok: false, error: '列/行必须是整数' };
        if (c < 0 || c > plan.cols - 1 || r < 0 || r > plan.rows - 1) {
          return { ok: false, error: '没有这个格：列 0~' + (plan.cols - 1) + '、行 0~' + (plan.rows - 1)
            + '（你给的是 ' + c + ', ' + r + '）' };
        }
        var x0 = c * plan.stepX, y0 = r * plan.stepY;
        var x1 = x0 + plan.stepX, y1 = y0 + plan.stepY;
        var cx = x0 + plan.stepX / 2, cy = y0 + plan.stepY / 2;
        return {
          ok: true, col: c, row: r, x0: x0, y0: y0, x1: x1, y1: y1, cx: cx, cy: cy,
          note: '格 (' + c + ', ' + r + ')　覆盖 x[' + gridNum(x0) + ', ' + gridNum(x1) + ') y['
            + gridNum(y0) + ', ' + gridNum(y1) + ')　左上 (' + gridNum(x0) + ', ' + gridNum(y0)
            + ')　中心 (' + gridNum(cx) + ', ' + gridNum(cy) + ')',
        };
      }

      /**
       * 像素 → 格。三态：
       *   `in`   = 落在某一格里（可用）
       *   `rest` = 落在**残格**里（画布内、但网格切不到 → 界外，不算）
       *   `out`  = 画布外（不算）
       */
      function gridPixelToCell(plan, px, py) {
        if (!plan || !plan.ok) return { ok: false, error: (plan && plan.error) || '网格参数不合法' };
        var x = Number(px), y = Number(py);
        if (!isFinite(x) || !isFinite(y)) return { ok: false, error: '像素坐标必须是数字' };
        var state;
        if (x < 0 || y < 0 || x >= plan.width || y >= plan.height) state = 'out';
        else if (x >= plan.coverX || y >= plan.coverY) state = 'rest';
        else state = 'in';
        var colRaw = Math.floor(x / plan.stepX + 1e-9);
        var rowRaw = Math.floor(y / plan.stepY + 1e-9);
        var head = '像素 (' + gridNum(x) + ', ' + gridNum(y) + ')　';
        var note;
        var cell = null;
        if (state === 'in') {
          cell = gridCellToPixel(plan, colRaw, rowRaw);
          note = head + cell.note;
        } else if (state === 'rest') {
          var why = [];
          if (x >= plan.coverX) {
            why.push('x ' + gridNum(x) + ' 落在第 ' + (colRaw + 1) + ' 格位置上（网格只有 ' + plan.cols
              + ' 格，到 ' + gridNum(plan.coverX) + '）');
          }
          if (y >= plan.coverY) {
            why.push('y ' + gridNum(y) + ' 落在第 ' + (rowRaw + 1) + ' 行位置上（网格只有 ' + plan.rows
              + ' 行，到 ' + gridNum(plan.coverY) + '）');
          }
          note = head + '界外（残格）不算 —— ' + why.join('；');
        } else {
          note = head + '界外（画布外）不算 —— 画布只有 ' + gridNum(plan.width) + ' × ' + gridNum(plan.height);
        }
        return {
          ok: true, px: x, py: y, state: state, inGrid: state === 'in',
          col: state === 'in' ? colRaw : null, row: state === 'in' ? rowRaw : null,
          colRaw: colRaw, rowRaw: rowRaw, cell: cell, note: note,
        };
      }

      /**
       * 网格线（给 SVG 用）。`d` 是一条 path 的 `d`（所有竖线 + 横线）。
       * ⚠️ 步长很小（如 1px）时线会多到把浏览器拖死 ⇒ **每条轴最多 200 条**，超了就**不画线**并如实标注。
       */
      function gridLines(plan) {
        if (!plan || !plan.ok) return { ok: false, xs: [], ys: [], d: '', cappedX: false, cappedY: false, note: '' };
        var cap = 200;
        var xs = [], ys = [], d = '';
        var cappedX = plan.cols > cap, cappedY = plan.rows > cap;
        var c, r;
        if (!cappedX) for (c = 0; c <= plan.cols; c++) xs.push(c * plan.stepX);
        if (!cappedY) for (r = 0; r <= plan.rows; r++) ys.push(r * plan.stepY);
        xs.forEach(function (x) { d += 'M' + gridNum(x) + ' 0L' + gridNum(x) + ' ' + gridNum(plan.height); });
        ys.forEach(function (y) { d += 'M0 ' + gridNum(y) + 'L' + gridNum(plan.width) + ' ' + gridNum(y); });
        var bits = [];
        if (cappedX) bits.push('列 ' + plan.cols + ' > ' + cap);
        if (cappedY) bits.push('行 ' + plan.rows + ' > ' + cap);
        return {
          ok: true, xs: xs, ys: ys, d: d, cappedX: cappedX, cappedY: cappedY, cap: cap,
          note: bits.length ? ('线太多（' + bits.join('、') + '）⇒ 图里没画格线，只画了边界；数字仍然准。') : '',
        };
      }

      /**
       * 每格的**灰色坐标标签**（"经纬度"）—— 2026-09-30 作者要求：图上每一格都要灰字写出它的坐标，
       * 这样不用来回换算就能指着图说话（"把模型放 8,10"）。
       *
       * `mode`：
       *   `center` = 该格**坐标** `x,y`（**默认**）—— ⚠️ 2026-10-01 起它**与「取哪一角」联动**：
       *             显示的就是那个角的坐标（默认右下）。名字里还留着 `center` 只是**为了老缓存能继续用**
       *             （改 id 会让已经存过的值静默回落）。
       *   `cell`   = 格号 `col,row`（网格自己的"经纬度"）
       *   `off`    = 不画
       *
       * 字号按**格子的实际大小**算（世界坐标），保证文字不越出本格：
       *   宽向上 `stepX × 0.9 / (最长文本长度 × 等宽字宽系数 0.58)`、高向上 `stepY × 0.62`，再夹到 ≤48。
       *   ⚠️ 用**真实最长文本长度**（不是拍一个"每字符系数"）：联动到角以后文本会变长
       *   （中心 `'50,25'` → 右下 `'1600,1000'`），拍脑袋的系数会让标签**越到邻格里去**。
       * ⚠️ 字太小（<14）或格太多（>600）就**不画**并如实说明 —— 画出来是糊的，等于骗人（与"线太多不画线"同一条纪律）。
       */
      function gridLabels(plan, mode, anchor) {
        var m = mode === 'cell' ? 'cell' : (mode === 'off' ? 'off' : 'center');
        if (!plan || !plan.ok || m === 'off') return { ok: true, mode: m, items: [], fontSize: 0, note: '' };
        var id = anchor || 'br';
        // 先把每格的文本算出来（也是"最长文本"的依据），再定字号
        var items = [];
        var maxLen = 0;
        for (var r = 0; r < plan.rows; r++) {
          for (var c = 0; c < plan.cols; c++) {
            var x0 = c * plan.stepX, y0 = r * plan.stepY;
            var pt = gridAnchorPoint({ x0: x0, y0: y0, x1: x0 + plan.stepX, y1: y0 + plan.stepY }, id);
            var text = m === 'center' ? (gridNum(pt.x) + ',' + gridNum(pt.y)) : (c + ',' + r);
            if (text.length > maxLen) maxLen = text.length;
            items.push({ col: c, row: r, x: x0 + plan.stepX / 2, y: y0 + plan.stepY / 2, text: text });
          }
        }
        // 0.9 = 左右各留 5% 余量；0.58 = 等宽字（ui-monospace / Consolas）的字符宽度系数
        var byWidth = plan.stepX * 0.9 / (Math.max(1, maxLen) * 0.58);
        var byHeight = plan.stepY * 0.62;
        // ⚠️ 向下取整到 0.1：四舍五入会把字号顶到上限之上（23.684 → 23.7 > 上限），那就不"塞得进"了
        var fontSize = Math.floor(Math.min(byWidth, byHeight, 48) * 10) / 10;
        var cap = 600;
        if (plan.cells > cap) {
          return { ok: true, mode: m, items: [], fontSize: 0, maxLen: maxLen,
            note: '格太多（' + plan.cells + ' > ' + cap + '）⇒ 图上没画格内坐标（画了也看不清）；格号可在下面列表里看。' };
        }
        if (fontSize < 14) {
          return { ok: true, mode: m, items: [], fontSize: fontSize, maxLen: maxLen,
            note: '格子太小（算出来字号 ' + gridNum(fontSize) + ' < 14）⇒ 图上没画格内坐标；滚轮放大看，或调大步长。' };
        }
        return { ok: true, mode: m, anchor: id, items: items, fontSize: fontSize, maxLen: maxLen, note: '' };
      }

      /**
       * 「当前点」那一行 —— **纯函数**：
       * 落在格里时给格的完整信息；**落在界外时直接回 `note`**（它本身就以 `像素 (x, y)　界外（残格）不算 —— …` 开头，
       * 这是那一刻最有用的一句话：既说清了"不算"，也说清了"你点的是哪儿"）。
       */
      function gridPointLine(info) {
        if (!info) return '（网格参数不合法 —— 先改上面的宽高与步长）';
        if (!info.ok) return info.error;
        if (info.inGrid && info.cell) return '当前点：' + info.cell.note;
        return info.note;
      }

      /* —— 多选（作者 2026-10-01：网格图要多选 + 下面一个列表 + 能单复制也能一起复制） —— */

      /** 选中集合里的一项 → 键（`col,row`）。 */
      function gridSelKey(col, row) { return col + ',' + row; }

      /**
       * 点一格 = **切换**它在选中集合里的状态（这就是"多选"）。
       * 纯函数：回新数组、不改入参、坏项直接丢掉（不把垃圾带进列表）。
       */
      function gridSelToggle(sel, col, row) {
        var list = Array.isArray(sel) ? sel : [];
        var key = gridSelKey(col, row);
        var out = [], found = false, i;
        for (i = 0; i < list.length; i++) {
          var it = list[i];
          if (!it || !isFinite(Number(it.col)) || !isFinite(Number(it.row))) continue;
          if (gridSelKey(Number(it.col), Number(it.row)) === key) { found = true; continue; }
          out.push({ col: Number(it.col), row: Number(it.row) });
        }
        if (!found) out.push({ col: col, row: row });
        return out;
      }

      /** 滚轮缩放的夹取（太小看不清、太大没人用；**是筛选不是判决**）。 */
      function gridZoomClamp(z) {
        var n = Number(z);
        if (!isFinite(n) || n <= 0) return 1;
        return Math.max(0.25, Math.min(8, n));
      }

      /* —— 右键标记颜色（作者 2026-10-01：「右键标记颜色…导出时候可以直接带 color」） —— */

      /**
       * 默认色板（作者：「默认放几个颜色就好了」）。**第一个是作者给的例子那个灰**。
       * `name` 进 `colorName`，`hex` 进 `color` —— 与导出片段逐字对应。
       */
      var GRID_COLORS = [
        { id: 'gray', name: '灰色', hex: '#d6d7dc' },
        { id: 'red', name: '红色', hex: '#e06c75' },
        { id: 'orange', name: '橙色', hex: '#e5a663' },
        { id: 'yellow', name: '黄色', hex: '#e8d06a' },
        { id: 'green', name: '绿色', hex: '#8fce8f' },
        { id: 'cyan', name: '青色', hex: '#6fd3d3' },
        { id: 'blue', name: '蓝色', hex: '#7aa7e8' },
        { id: 'purple', name: '紫色', hex: '#b18ce0' },
      ];

      /** 色 id → 色条（未知 id 回 null —— 不编一个颜色出来）。 */
      function gridColorById(id) {
        var want = String(id || '');
        for (var i = 0; i < GRID_COLORS.length; i++) if (GRID_COLORS[i].id === want) return GRID_COLORS[i];
        return null;
      }

      /**
       * 右键点一格 = **切换**它的颜色（再点同一个色就是清除）。
       * 纯函数：回新 map、不改入参；`colorId` 不认识就当"清除"。
       */
      function gridColorToggle(map, col, row, colorId) {
        var out = {};
        var src = map && typeof map === 'object' ? map : {};
        Object.keys(src).forEach(function (k) { out[k] = src[k]; });
        var key = gridSelKey(col, row);
        var c = gridColorById(colorId);
        if (!c || src[key] === c.id) delete out[key];
        else out[key] = c.id;
        return out;
      }

      /** 一格的颜色（回 `{id,name,hex}` 或 null）。 */
      function gridColorOf(map, col, row) {
        var src = map && typeof map === 'object' ? map : {};
        return gridColorById(src[gridSelKey(col, row)]);
      }

      /* —— 四角锚点（作者 2026-10-01：「增加四角下拉选择…默认是右下」） —— */

      /**
       * 四个角：**复制出去的 `x,y` 取哪一个点**（默认 `br` 右下）。
       * 摆模型时"锚点"是右下的情况很常见（右下角对齐），所以默认给右下，而不是中心。
       */
      var GRID_ANCHORS = [
        { id: 'br', name: '右下' },
        { id: 'bl', name: '左下' },
        { id: 'tl', name: '左上' },
        { id: 'tr', name: '右上' },
      ];

      /** 锚点 id → 中文名（未知 id 回落到默认那个）。 */
      function gridAnchorName(id) {
        var want = String(id || '');
        for (var i = 0; i < GRID_ANCHORS.length; i++) if (GRID_ANCHORS[i].id === want) return GRID_ANCHORS[i].name;
        return GRID_ANCHORS[0].name;
      }

      /** 一个格的某个角 → `{x, y}`（`cell` 来自 `gridCellToPixel`）。 */
      function gridAnchorPoint(cell, id) {
        var c = cell || {};
        var x0 = Number(c.x0) || 0, y0 = Number(c.y0) || 0;
        var x1 = Number(c.x1) || 0, y1 = Number(c.y1) || 0;
        if (id === 'tl') return { x: x0, y: y0 };
        if (id === 'tr') return { x: x1, y: y0 };
        if (id === 'bl') return { x: x0, y: y1 };
        return { x: x1, y: y1 };   // 默认右下
      }

      /**
       * **只加不减**地把一格放进选中集合 —— **右键标记专用**。
       *
       * ⚠️ 为什么不能直接用 `gridSelToggle`：标记颜色本来**不该改变选中状态**，而 toggle 会把**已经选中**的那格
       * 踢出去 ⇒ 表现就是「右键标个颜色，列表里的格没了、复制按钮变灰」（作者 2026-10-01 报的正是这个）。
       * 已经在里面就**原样返回**（同一个引用，React 会跳过这次重渲染）。
       */
      function gridSelAdd(sel, col, row) {
        var list = Array.isArray(sel) ? sel : [];
        for (var i = 0; i < list.length; i++) {
          var it = list[i];
          if (it && Number(it.col) === col && Number(it.row) === row) return list;
        }
        return gridSelToggle(list, col, row);
      }

      /**
       * 只保留**当前网格里还存在**的那些格（"移除失效行"按钮用）。纯函数，不改入参。
       */
      function gridSelPrune(plan, sel) {
        var list = Array.isArray(sel) ? sel : [];
        if (!plan || !plan.ok) return list;
        return list.filter(function (it) {
          return gridCellToPixel(plan, Number(it && it.col), Number(it && it.row)).ok;
        });
      }

      /**
       * 选中集合 → 逐行数据（按**当前**网格算坐标；`x,y` 取**选的角**；带上右键标记的颜色）。
       * ⚠️ 网格改小之后，原来选的格可能**不再存在** ⇒ 那一行 `ok:false` 并说明原因
       * （**既不静默丢掉、也不拿邻近格顶替** —— 那正是"看着对、其实差一格"的来源）。
       */
      function gridSelRows(plan, sel, anchor, colors) {
        if (!plan || !plan.ok) return [];
        var id = anchor || 'br';
        return (Array.isArray(sel) ? sel : []).map(function (it) {
          var col = Number(it && it.col), row = Number(it && it.row);
          var c = gridCellToPixel(plan, col, row);
          if (!c.ok) return { col: col, row: row, ok: false, error: c.error };
          var pt = gridAnchorPoint(c, id);
          var mark = gridColorOf(colors, col, row);
          return {
            col: col, row: row, ok: true, anchor: id, anchorName: gridAnchorName(id),
            x: pt.x, y: pt.y, x0: c.x0, y0: c.y0, note: c.note,
            color: mark ? mark.hex : null, colorName: mark ? mark.name : null,
          };
        });
      }

      /**
       * 选中集合 → **一起复制**的正文。格式由作者给定（2026-10-01）：
       * ```
       * [{x = 730, y = 460 },
       * {x = 840, y = 540 }]
       * ```
       * 带颜色的格（右键标记过）多两段 —— **逐字**照作者给的例子：
       * ```
       * [{x = 330, y = 560 ,color="#d6d7dc",colorName = "灰色"}]
       * ```
       * `x,y` = 该格**选定的那个角**（默认右下；见 `GRID_ANCHORS`）。
       * 不可用的行**不写进去** —— 复制出来的东西必须是能直接用的。
       */
      function gridSelLua(rows) {
        var items = (Array.isArray(rows) ? rows : []).filter(function (r) { return r && r.ok; })
          .map(function (r) {
            var head = '{x = ' + gridNum(r.x) + ', y = ' + gridNum(r.y) + ' ';
            if (r.color) return head + ',color="' + r.color + '",colorName = "' + String(r.colorName || '') + '"}';
            return head + '}';
          });
        return '[' + items.join(',\n') + ']';
      }

      /* —— 缓存（localStorage）：作者要"不想每次打开都重新输入" —— */

      var GRID_STORE_KEY = 'dsh-miliastra:grid';
      var PANEL_OPEN_KEY = 'dsh-miliastra:panel-open';
      var PANEL_PIN_KEY = 'dsh-miliastra:panel-pinned';
      var PANEL_POS_KEY = 'dsh-miliastra:panel-pos';
      var gridStoreCache = null;

      /**
       * 读一小段 JSON。**任何异常都回 null**（隐私模式 / 配额满 / 被禁都只意味着"没缓存"），
       * 但**绝不假装读到了** —— 调用方拿 null 就走默认值。
       */
      function storeGet(key) {
        try {
          if (typeof localStorage === 'undefined' || !localStorage) return null;
          var raw = localStorage.getItem(key);
          if (!raw) return null;
          var v = JSON.parse(raw);
          return v && typeof v === 'object' ? v : null;
        } catch (e) { return null; }
      }

      /** 写一小段 JSON。**回 false = 没存下来** —— 调用方要如实告诉人，不许静默。 */
      function storeSet(key, obj) {
        try {
          if (typeof localStorage === 'undefined' || !localStorage) return false;
          localStorage.setItem(key, JSON.stringify(obj));
          return true;
        } catch (e) { return false; }
      }

      /**
       * 面板开合 / 常驻两个开关。
       * `dft` 是**没有存过**时的默认：
       *   · 开合 → **false（默认关）**：作者早就立过"不该一上来就糊一层"（`client-render-test` 有断言钉住）；
       *     一旦他点开过，之后（含刷新）就**一直记着开着** ⇒ 满足"一直展示在旁边辅助我"。
       *   · 常驻 → **true（默认常驻）**：作者 2026-10-01 明说"不想点输入框就被关掉"。
       */
      function panelPref(key, dft) {
        var v = storeGet(key);
        return v && typeof v.on === 'boolean' ? v.on : dft;
      }
      function panelPrefSet(key, on) { return storeSet(key, { on: !!on }); }

      /** 网格页上次填的东西（进程内只解析一次）。 */
      function gridSaved() {
        if (gridStoreCache === null) gridStoreCache = storeGet(GRID_STORE_KEY) || {};
        return gridStoreCache;
      }

      /** 逐格速查表（格数 > max 就**不建表**，只如实报总数 —— 免得 160 万格把页面拖死）。 */
      function gridTable(plan, max) {
        if (!plan || !plan.ok) return { ok: false, error: (plan && plan.error) || '网格参数不合法', rows: [] };
        var cap = isFinite(Number(max)) ? Number(max) : 200;
        if (plan.cells > cap) return { ok: true, rows: [], total: plan.cells, truncated: true, cap: cap };
        var rows = [];
        for (var r = 0; r < plan.rows; r++) {
          for (var c = 0; c < plan.cols; c++) {
            var x0 = c * plan.stepX, y0 = r * plan.stepY;
            rows.push({ col: c, row: r, x0: x0, y0: y0, cx: x0 + plan.stepX / 2, cy: y0 + plan.stepY / 2 });
          }
        }
        return { ok: true, rows: rows, total: plan.cells, truncated: false, cap: cap };
      }

      /** 速查表 → TSV（人可直接贴进表格 / 记事本）。 */
      function gridTableTsv(t) {
        var out = ['col\trow\tx_left\ty_top\tx_center\ty_center'];
        ((t && t.rows) || []).forEach(function (x) {
          out.push([x.col, x.row, gridNum(x.x0), gridNum(x.y0), gridNum(x.cx), gridNum(x.cy)].join('\t'));
        });
        return out.join('\n');
      }

      /** 一键复制的正文：参数 + 结论 + 当前两个换算。 */
      function gridCopyText(plan, pxInfo, cellInfo) {
        var out = ['网格计算（画布 ' + gridNum(plan && plan.width) + ' × ' + gridNum(plan && plan.height)
          + '，步长 X ' + gridNum(plan && plan.stepX) + ' / Y ' + gridNum(plan && plan.stepY) + '）'];
        gridSummaryLines(plan).forEach(function (l) { out.push(l); });
        if (pxInfo && pxInfo.ok) out.push(pxInfo.note);
        if (cellInfo && cellInfo.ok) out.push(cellInfo.note);
        return out.join('\n');
      }

      /**
       * 网格预设（快捷按钮）。默认给的是**推荐值** X 100 / Y 50；
       * 第二个是作者给的"除不尽"例子（残 60 / 40）—— 用来演示"界外不算"这条规则。
       */
      var GRID_PRESETS = [
        { w: 1600, h: 1000, sx: 100, sy: 50, label: '1600×1000 · X100/Y50（推荐）' },
        { w: 1600, h: 1000, sx: 110, sy: 80, label: '1600×1000 · X110/Y80（残 60/40）' },
        { w: 1600, h: 1000, sx: 100, sy: 100, label: '1600×1000 · X100/Y100（正方形）' },
        { w: 1600, h: 1000, sx: 50, sy: 50, label: '1600×1000 · X50/Y50（细）' },
      ];

      /* ---------------------------------------------------------------- 模拟器视图 */

      /**
       * 操作时间线的一行：`t=0.53  pointer click (800,450)`。
       * 人能对上"自己刚才做了什么"，AI 也能照着写成 `verify` 的 `steps[]`（同一份历史就是 `fromHistory` 的来源）。
       */
      function histLine(e) {
        var p = (e && e.payload) || {};
        var what = (e && e.kind) || '?';
        if (what === 'pointer') what = 'pointer ' + (p.type || '') + ' (' + p.x + ',' + p.y + ')';
        else if (what === 'key') what = 'key ' + (p.typeName || '');
        else if (what === 'click') what = 'click ' + (p.name || '');
        else if (what === 'view') what = 'view P' + (p.playerIndex || 1);
        else if (what === 'serverSet') what = 'setVar ' + p.entityType + '.' + p.name + ' = ' + p.value;
        else if (what === 'serverSend') what = 'signal ' + (p.name || '') + '(' + (p.params || []).join(',') + ')';
        return 't=' + (Number(e && e.t) || 0).toFixed(2) + '  ' + what;
      }

      /**
       * 「任意本地 .lua（绝对路径）」要发的两个请求体 —— **纯函数**，单独回归。
       *
       * 为什么值得单列：`source` 必须是**粘贴的那个路径**。一旦这里串成沙箱活文件路径，
       * 面板就会「看起来读了、其实读的是另一个文件」—— 而它不报错，只是给错答案。
       */
      function externalLuaReadRequests(p) {
        return [
          { name: 'miliastra_code', args: { op: 'read', source: p, head: 60 } },
          { name: 'miliastra_sim', args: { op: 'handover', source: p } },
        ];
      }

      /**
       * `op=handover` 的回执 → 「候选交接值」表的行（**纯函数**，单独回归）。
       *
       * 为什么单列：这张表决定「点一下『用它搭进模拟器』会建什么」——
       * `isTemplate:true` 的候选**默认预勾选**（省一步手点），`kindHint` 直接当初始 kind（拿不准仍可在表里改）。
       */
      function extRowsFromHandover(ho) {
        return ((ho && ho.candidates) || []).map(function (c) {
          return { name: c.name, value: c.value, kind: c.isTemplate ? c.kindHint : '', on: !!c.isTemplate };
        });
      }

      /** `op=handover` 抽到的容器索引 → 输入框的初值（没抽到就是空串：**不编一个号**）。 */
      function extContainerFromHandover(ho) {
        return (ho && ho.containerId) ? String(ho.containerId) : '';
      }

      /**
       * 「候选交接值」那一行的文案（**纯函数**）。
       *
       * 候选为空时**必须指路**（作者 2026-09-25 报的缺陷）：这份源码里没认出模板索引 →
       * 第二条自动来源是 `.gil`（miliastra_map op=clientui），两条都拿不到才手填 —— 不能只回一句「一条都没有」。
       * ⚠️ 面板不渲染 Markdown：这段字里不许出现星号加粗 / 反引号（有回归钉住）。
       */
      function extCandidatesLine(ho) {
        if (ho && ho.ok === false) return '候选交接值：抽取失败 —— ' + (ho.error || '未知原因');
        var c = (ho && ho.candidates) || [];
        if (!c.length) {
          return '候选交接值 0 条：没从这份源码里认出模板索引 → 可从 .gil 读（miliastra_map op=clientui），或手填。';
        }
        return '候选交接值 ' + c.length + ' 条（启发式，kind 得你自己确认）：'
          + c.map(function (x) { return x.name + ' = ' + x.value + (x.kindHint ? '（像 ' + x.kindHint + '）' : ''); }).join('，');
      }

      /**
       * 「用它搭进模拟器」旁边那句「还缺什么」（**纯函数**）。
       *
       * 候选为空时按钮**仍然可点**（人可能就想看看报错），但必须写清缺什么 ——
       * 否则它看起来"现在就能用"，点下去只会因缺 templates 报错（这正是"看起来能用"的那类骗人界面）。
       */
      function extBindReadyHint(rows) {
        var tpl = (rows || []).filter(function (x) { return x.on && x.kind; });
        if (!tpl.length) {
          return '还缺模板：现在点它会因为缺 templates 报错 —— 先「读取」抽候选，或手填模板索引并在下表勾上。';
        }
        return '将用 ' + tpl.length + ' 个模板搭进模拟器：'
          + tpl.map(function (t) { return t.name + '（' + t.value + ' → ' + t.kind + '）'; }).join('，');
      }

      /** 「用它搭进模拟器」的请求体：同样的 `source` 走 `op=bind`（**只把脚本投进模拟器，不动活文件**）。 */
      function externalLuaBindArgs(p, templates, containerId) {
        var args = { op: 'bind', source: p, templates: templates || [], keepRunning: true };
        var c = Number(containerId);
        if (isFinite(c) && c > 0) args.containerId = c;
        return args;
      }

      /**
       * 「模拟器」tab：会话区全宽视图，直接打 `/miliastra/engine` ——
       * 与 `miliastra_sim` 工具**同一个入口**，所以面板里看到的和 AI 操作的是**同一份**工程状态。
       *
       * 画面**不由面板自己渲染**：右列那个 iframe 就是试玩页（GET /miliastra/play，PixiJS WebGL，人真能玩），
       * 左列只放「读本地 .lua / 日志 / 操作 / 时间线 / 验收单 / 工程」。
       * 作者 2026-09-25：「画面和截取画面功能很鸡肋不要了 GUI 部分直接删除」—— 面板不再取图、也没有连帧；
       * 交互：开始试玩 → 引擎在可终止的 Worker 里跑 Lua → 在右列试玩页里看画面 / 操作。
       */
      function SimulatorBody() {
        var s1 = React.useState(null); var st = s1[0]; var setSt = s1[1];
        var s2 = React.useState(''); var err = s2[0]; var setErr = s2[1];
        var s3 = React.useState(true); var busy = s3[0]; var setBusy = s3[1];
        var s5 = React.useState([]); var logs = s5[0]; var setLogs = s5[1];
        var s6 = React.useState(false); var running = s6[0]; var setRunning = s6[1];
        /*
         * ⚠️ 「连帧」（auto）与「画面」（shot）两个 state 已删（作者 2026-09-25：画面/截取画面 GUI 不要了）。
         * 删掉的不只是两个按钮：**面板从此不再调 op=shot** —— 它也不会再往磁盘写 PNG 了。
         */
        var s8 = React.useState({ keys: [], presets: [], from: '' }); var keyInfo = s8[0]; var setKeyInfo = s8[1];
        var s9 = React.useState(''); var keyName = s9[0]; var setKeyName = s9[1];
        // 画布/人数/视角**固定**（作者要求去掉切换）—— 这三个 state 已不再需要，全部走引擎默认值
        // ③ 「AI 试玩区域」的两个读数：这一局的帧头信息，以及**可重放的操作时间线**
        var s13 = React.useState({ frame: 0, time: 0, controls: 0 }); var stat = s13[0]; var setStat = s13[1];
        var s14 = React.useState([]); var hist = s14[0]; var setHist = s14[1];
        // 工程适配（op=handover / op=bind）
        var s15 = React.useState(null); var bindInfo = s15[0]; var setBindInfo = s15[1];
        var s16 = React.useState(''); var bindPath = s16[0]; var setBindPath = s16[1];
        var s17 = React.useState([]); var bindRows = s17[0]; var setBindRows = s17[1];
        var s18 = React.useState(''); var bindContainer = s18[0]; var setBindContainer = s18[1];
        var s19 = React.useState(null); var bindRes = s19[0]; var setBindRes = s19[1];
        // 验收单（op=cases）
        var s20 = React.useState(null); var book = s20[0]; var setBook = s20[1];
        var s21 = React.useState(''); var bookSet = s21[0]; var setBookSet = s21[1];
        var s22 = React.useState('[{"kind":"log","contains":"就绪"}]'); var expectText = s22[0]; var setExpectText = s22[1];
        var s23 = React.useState(''); var caseName = s23[0]; var setCaseName = s23[1];
        var s24 = React.useState(''); var caseNote = s24[0]; var setCaseNote = s24[1];
        var s25 = React.useState(null); var caseResults = s25[0]; var setCaseResults = s25[1];
        // 试玩页 iframe 的「重载」计数（改 key 就重挂）
        var s26 = React.useState(0); var playNonce = s26[0]; var setPlayNonce = s26[1];
        // 任意本地 .lua（绝对路径）：只读看一眼 + 能一键搭进模拟器（作者追问后选的「两个都要」）
        var s27 = React.useState(''); var extPath = s27[0]; var setExtPath = s27[1];
        var s28 = React.useState(null); var extInfo = s28[0]; var setExtInfo = s28[1];

        var engine = React.useCallback(function (args, quiet) {
          if (!quiet) { setBusy(true); setErr(''); }
          return fetch(PREFIX + '/engine', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(args || {}),
          }).then(function (r) { return r.json(); })
            .then(function (env) {
              if (!env || env.ok === false) throw new Error((env && env.error) || '引擎调用失败');
              return env.data || {};
            })
            .catch(function (e) { setErr((e && e.message) || String(e)); return null; })
            .then(function (d) { if (!quiet) setBusy(false); return d; });
        }, []);

        var refresh = React.useCallback(function () {
          return engine({ op: 'state', summaryOnly: false }).then(function (d) { if (d) setSt(d); });
        }, [engine]);

        React.useEffect(function () { refresh(); }, [refresh]);

        // 进页面就拉一次「你脚本在听哪些键」（op=keys 从脚本源码扫 KeyEventType），有就用它做按钮
        React.useEffect(function () {
          engine({ op: 'keys' }, true).then(function (d) {
            if (!d) return;
            setKeyInfo({ keys: d.keys || [], presets: d.presets || [], from: d.from || '' });
            if (d.keys && d.keys.length) setKeyName(function (prev) { return prev || d.keys[0]; });
          });
        }, [engine]);

        var doPlay = React.useCallback(function (action, a) {
          return engine({ op: 'play', action: action, args: a || {} }).then(function (d) {
            if (!d) return null;
            if (Array.isArray(d.logs)) {
              setLogs(d.logs.map(function (l) { return (l && l.text) || ''; }));
            }
            // 「AI 试玩区域」的状态行：帧 / 时间 / 控件数（引擎每次回快照都带着）
            if (d.frame !== undefined || d.treeCount !== undefined || d.controlCount !== undefined) {
              setStat({
                frame: Number(d.frame) || 0,
                time: Number(d.time) || 0,
                controls: Number(d.treeCount || d.controlCount) || 0,
              });
            }
            // 操作时间线：引擎把人的每一次点/按键/拖拽都记在 history 里（AI 的 fromHistory 用的就是它）
            if (Array.isArray(d.history)) {
              setHist(d.history.slice(-12).map(histLine));
            }
            if (action === 'start') setRunning(true);
            if (action === 'stop') { setRunning(false); setLogs([]); setHist([]); }
            return d;
          });
        }, [engine]);

        var kids = [];
        kids.push(React.createElement('div', { className: PLUGIN + '-head', key: 'head' },
          React.createElement(Icon, { k: 'mk' }),
          React.createElement('span', { className: PLUGIN + '-title', key: 'ti' }, '模拟器'),
          React.createElement('span', { className: PLUGIN + '-badge', key: 'bg' }, running ? '试玩中' : '就绪'),
          React.createElement('span', { className: PLUGIN + '-spacer', key: 'sp' }),
          React.createElement('button', {
            className: PLUGIN + '-act', key: 'rf', disabled: busy,
            onClick: function () { refresh(); },
          }, busy ? '刷新中…' : '刷新')));
        if (err) kids.push(React.createElement('div', { className: PLUGIN + '-err', key: 'err', style: { margin: '9px 13px 0' } }, err));

        var info = st ? [
          ['画布', (st.canvas && st.canvas.label) || st.canvasId || '—'],
          ['控件', String(st.treeCount || 0) + ' 个'],
          ['脚本', String(st.scriptCount || 0) + ' 个'],
          ['存档', (st.save && st.save.name) || '—'],
        ] : [];
        var rows = [];
        for (var i = 0; i < info.length; i += 1) {
          rows.push(React.createElement('div', { className: PLUGIN + '-k', key: 'k' + i }, info[i][0]));
          rows.push(React.createElement('div', { className: PLUGIN + '-v', key: 'v' + i }, info[i][1]));
        }

        var treeNodes = (st && st.tree ? st.tree : []).slice(0, 80).map(function (n) {
          return React.createElement('div', {
            className: PLUGIN + '-log', key: 'n' + n.id,
            style: { paddingLeft: (6 + (n.depth || 0) * 10) + 'px', cursor: 'pointer' },
            title: '点一下在引擎里选中它（op=patch select）',
            onClick: function () {
              engine({ op: 'patch', patch: { op: 'select', id: n.id } }).then(function (d) { if (d) setSt(d); });
            },
          }, n.id + '  ' + n.kind + '  ' + (n.name || ''));
        });

        var btn = function (label, cls, fn, key) {
          return React.createElement('button', {
            className: PLUGIN + '-act' + (cls ? ' ' + cls : ''), key: key, disabled: busy, onClick: fn,
          }, label);
        };
        /*
         * 面板自己的按钮**只留最必要的**：试玩页里已经有一整套（开始/暂停/单步/重开/结束/设备/人数/视角），
         * 左列 1/3 宽塞不下两份 —— 作者 2026-09-24 截图里"按钮和文字叠在一起"就是塞太满 + 子项被压扁两件事一起造成的。
         * 2026-09-25 又裁一轮（「画面和截取画面功能很鸡肋不要了 GUI 部分直接删除」）：
         * **取图 / 连帧 / 刷新画面 全删**，这里只剩**传输控制** —— 画面去右边那个试玩页看。
         */
        var transportRow = React.createElement('div', { className: PLUGIN + '-row', key: 'act' },
          btn(running ? '重开试玩' : '开始试玩', PLUGIN + '-primary', function () {
            // 画布/人数/视角固定 → 不带任何参数，交给引擎默认（PC 16:9 / 1 人 / P1）
            doPlay('start');
          }, 'b2'),
          btn('单步', null, function () {
            // 单帧确定性推进：**先暂停**再 step（跑着的时候引擎那个 30FPS 时钟自己也在走）
            doPlay('pause').then(function () { return doPlay('step', { dt: 0.033 }); });
          }, 'b3'),
          btn('停止', null, function () { doPlay('stop'); }, 'b5'));

        /** 试玩页里也有、但面板上仍值得留一手的**非取图**动作（导出 / 浏览器试玩 / 重置工程）。 */
        var advActions = React.createElement('div', { className: PLUGIN + '-row', key: 'act' },
          btn('导出 GIA', null, function () {
            engine({ op: 'export', format: 'gia' }).then(function (d) {
              if (!d) return;
              setLogs(function (prev) {
                return prev.concat(['导出 ' + d.name + '（' + d.bytesText + '） → ' + d.file,
                  '⚠️ 这个 .gia 还没在真机编辑器里导入验证过 —— 拿它去试，结果记回 docs/']);
              });
            });
          }, 'b8'),
          /**
           * 浏览器试玩页（W2）：WebGL 渲染的**真·能玩**页面，与面板/AI 共用同一个会话。
           * 为什么不塞进面板：pixi 需要 WebGL + 自己的 CSP 处理，独立页最稳；
           * 而且它**关页不停局** —— AI 能把人刚玩的那一局直接变成回归用例（`op=verify fromHistory:true`）。
           */
          React.createElement('a', {
            className: PLUGIN + '-act', key: 'b9', href: PREFIX + '/play', target: '_blank', rel: 'noreferrer',
            title: '浏览器试玩页（WebGL）：与这里、与 AI 共用同一份工程与同一个会话；玩完可以让 AI 用 op=verify fromHistory:true 把这局变成回归用例',
            style: { textDecoration: 'none', display: 'inline-flex', alignItems: 'center' },
          }, '浏览器试玩 ↗'),
          btn('重置工程', null, function () {
            engine({ op: 'reset' }).then(function (d) {
              if (d) { setSt(d); setLogs([]); setRunning(false); }
            });
          }, 'b7'));

        /** 按键行：优先用**你脚本真正在听的键**（`op=keys` 从脚本源码扫出来的），没有就用引擎的官方键名预设。 */
        var keyCandidates = ((keyInfo.keys && keyInfo.keys.length ? keyInfo.keys : keyInfo.presets) || []).slice(0, 6);
        var keyRow = React.createElement('div', { className: PLUGIN + '-row', key: 'keys' },
          React.createElement('span', { className: PLUGIN + '-hint', key: 'kh' }, '按键：'),
          keyCandidates.map(function (k) {
            return React.createElement('button', {
              className: PLUGIN + '-act', key: 'k' + k, disabled: busy, title: k,
              onClick: function () { doPlay('key', { key: k }); },
            }, String(k).replace('Keyboard', '').replace('Controller', 'C-'));
          }),
          React.createElement('input', {
            className: PLUGIN + '-act', key: 'ki', value: keyName,
            placeholder: '键名，如 KeyboardCraftspersonKey1Down',
            style: { minWidth: '170px' },
            onChange: function (e) { setKeyName(e.target.value); },
          }),
          React.createElement('button', {
            className: PLUGIN + '-act', key: 'ks', disabled: busy || !keyName,
            onClick: function () { doPlay('key', { key: keyName }); },
          }, '发送键'));

        /**
         * ★ **画布/人数/视角固定**（作者要求：「我希望固定这样 把切换的功能去掉吧」）。
         * 面板里原来也有「设备 / 人数 / 视角」三个下拉，现在整块去掉，固定成 PC 16:9 / 1 人 / P1：
         * ① 切设备会**重建整个运行时**（画布一变，16:9 舞台与 AI 记下的操作坐标都要重算）——
         *    实测还踩到过"手写的设备清单里有引擎不存在的预设 → `unknown canvas preset`"（试玩页那条红条）；
         * ② 这两个开关对"在面板里跑一局看看"没有增益。
         * ⚠️ **能力没丢**：AI 仍可用 `miliastra_sim {"op":"play","action":"device"/"view"}` 与 `playerCount` 改；
         * 这里只是不再给人一个会打歪画布尺寸的开关。
         */
        var fixedCfgRow = React.createElement('div', { className: PLUGIN + '-hint', key: 'fixed' },
          '画布/人数/视角固定：' + ((st && st.canvas && st.canvas.label) || 'PC 1600×900') + ' · 1 人 · P1'
          + '（要换设备/人数/视角请让 AI 用「miliastra_sim op=play device|view」）');

        var statFrame = stat.frame + (stat.time ? '（t=' + stat.time.toFixed(2) + 's）' : '');
        var statControls = stat.controls || (st ? (st.treeCount || 0) : 0);

        /* ---------------------------------------------- 工程适配（op=bind） */

        var kindOpts = ['image', 'textbox', 'button', 'container', 'cursor', 'grid', 'reference', 'textwindow', 'keyhint', 'animation', 'fullscreen'];

        /*
         * 任意本地 .lua（绝对路径）—— 作者的原话是「现在不能直接看 我希望编辑器面板增加一个
         * 输入 lua 的绝对路径读取的功能」；追问后他选「两个都要」：**先看**（元信息 + 正文预览 +
         * 候选交接值），**再一键搭进模拟器去跑**。
         *
         * ⚠️ 两条边界（写在这里，免得被后来者改坏）：
         *   ① 读取是**只读**的（miliastra_code op=read，不写任何文件）；
         *   ② 「用它搭进模拟器」只把脚本投进**模拟器工程**，与沙箱活文件无关（这不是部署）。
         *
         * ★ 2026-09-25 位置调整（作者原话「绝对路径的入口放做在左边最顶上」）：
         * 它原来塞在「④ 工程与控件树 / 工程适配」里，跟沙箱活文件那条混在一块、还要先展开折叠卡才看得见；
         * 现在提成**左列最上面的独立小卡**（标题「读本地 .lua（绝对路径）」，下一张卡就是「① 试玩日志」）。
         * 交互一个字没改 —— 改的只是它在左列的位置与卡壳。
         */
        var extRead = extInfo && extInfo.read ? extInfo.read : null;
        var extHo = extInfo && extInfo.handover ? extInfo.handover : null;
        // 候选行的文案统一走 extCandidatesLine(extHo)（含"没抽到就指路"那一段），这里不再自己拼
        var extSug = (extHo && extHo.suggestedTemplates) || [];
        var extCard = sec('读本地 .lua（绝对路径）', extInfo ? basename(extInfo.path) : '任意本地 .lua · 只读',
          React.createElement('div', { key: 'ext', style: { display: 'flex', flexDirection: 'column', gap: '5px' } },
            React.createElement('div', { className: PLUGIN + '-hint', key: 't1' },
              '任意本地 .lua（绝对路径）—— 这条是只读看一眼，也可以直接搭进模拟器'),
            React.createElement('div', { className: PLUGIN + '-hint', key: 't2' },
              '另一种是沙箱活文件（正在开发的那张图，在下面「工程与控件树 / 工程适配」里挑，路径随账号/换图而变）；'
              + '这条是你手上任意一个 .lua —— 它不必在沙箱里，读取不会改动它，搭进模拟器也只动模拟器工程'),
            React.createElement('div', { className: PLUGIN + '-row', key: 'r1' },
              React.createElement('input', {
                className: PLUGIN + '-act', key: 'p', type: 'text', value: extPath,
                'aria-label': '本地 .lua 的绝对路径',
                placeholder: '粘贴 .lua 的绝对路径，例如 C:\\Users\\me\\Desktop\\背景图片.lua',
                style: { flex: '1 1 220px', minWidth: '170px' },
                onChange: function (e) { setExtPath(e.target.value); },
              }),
              React.createElement('button', {
                className: PLUGIN + '-act', key: 'rd', disabled: busy || !extPath.trim(),
                title: '只读读取这个绝对路径（miliastra_code op=read）+ 抽候选交接值（miliastra_sim op=handover）',
                onClick: function () {
                  var p = extPath.trim();
                  if (!p) return;
                  var reqs = externalLuaReadRequests(p);
                  setBusy(true); setErr('');
                  Promise.all(reqs.map(function (r) { return callTool(r.name, r.args); }))
                    .then(function (rs) {
                      var read = (rs && rs[0]) || {};
                      var ho = (rs && rs[1]) || {};
                      setExtInfo({ path: p, read: read, handover: ho });
                      if (read.ok === false) setErr(read.error || '读取失败');
                      // 候选交接值接到下面那张表（勾选 / kind 只在同一个地方改，不另起一套）
                      // ★ isTemplate 的候选**默认预勾选**、容器索引**直接预填**（省一步手点；拿不准再改）
                      setBindRows(extRowsFromHandover(ho));
                      var ci = extContainerFromHandover(ho);
                      if (ci) setBindContainer(ci);
                    })
                    .catch(function (e) { setErr(String((e && e.message) || e)); })
                    .then(function () { setBusy(false); });
                },
              }, '读取'),
              React.createElement('button', {
                className: PLUGIN + '-act ' + PLUGIN + '-primary', key: 'go', disabled: busy || !extPath.trim(),
                title: '用粘贴的那个路径作为 source 走 op=bind：投进模拟器并起一次会话（不动沙箱活文件）',
                onClick: function () {
                  var p = extPath.trim();
                  if (!p) return;
                  var templates = bindRows.filter(function (x) { return x.on && x.kind; })
                    .map(function (x) { return { guid: x.value, kind: x.kind, name: x.name }; });
                  engine(externalLuaBindArgs(p, templates, bindContainer)).then(function (d) {
                    if (!d) return;
                    setBindRes(d);
                    setLogs(((d.run && d.run.logs) || []).map(function (l) { return (l && l.text) || ''; }));
                    if (d.run) { setRunning(true); setStat({ frame: d.run.frame || 0, time: d.run.time || 0, controls: d.run.controlCount || 0 }); }
                    setPlayNonce(function (n) { return n + 1; });
                    return refresh();
                  });
                },
              }, '用它搭进模拟器')),
            // ★ 按钮旁边写清"还缺什么"：候选为空时它**仍然可点**（人可能想看报错），
            //   但不能让它看起来"现在就能用"（点下去只会缺 templates 报错）。
            React.createElement('div', { className: PLUGIN + '-hint', key: 'rdy' }, extBindReadyHint(bindRows)),
            extInfo
              ? React.createElement('div', { key: 'res', style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
                React.createElement('div', { className: PLUGIN + '-hint', key: 'm1' },
                  (extRead && extRead.ok)
                    ? ('元信息：' + extRead.bytes + ' 字节 · ' + extRead.lines + ' 行 · sha256 ' + extRead.sha256_12
                      + ' · ' + hhmm(extRead.mtime) + ' · ' + (extRead.bom ? '带 BOM（会让 Lua 报错）' : '无 BOM'))
                    : ('读取失败：' + ((extRead && extRead.error) || '未知原因'))),
                (extRead && extRead.ok)
                  ? React.createElement('div', { className: PLUGIN + '-log', key: 'pv', style: { maxHeight: '150px' } },
                    (extRead.text || '（空文件）')
                    + (extRead.truncated ? '\n… 只显示前 ' + extRead.headCount + ' 行（全文 ' + extRead.lines + ' 行）' : ''))
                  : null,
                React.createElement('div', { className: PLUGIN + '-hint', key: 'c1' }, extCandidatesLine(extHo)),
                React.createElement('div', { className: PLUGIN + '-hint', key: 'c2' },
                  '它建议的模板：' + (extSug.length
                    ? extSug.map(function (t) { return t.name + ' → ' + t.kind + '（' + t.guid + '）'; }).join('，')
                    : '（无）')
                  + ' · 容器索引：' + ((extHo && extHo.containerId) || '（没抽到）')),
                React.createElement('div', { className: PLUGIN + '-hint', key: 'c3' },
                  '勾选与 kind 用的是下面「候选交接值」那张表（读取会替换它）—— 确认没问题再点「用它搭进模拟器」'))
              : React.createElement('div', { className: PLUGIN + '-hint', key: 'e0' },
                '还没读：粘上绝对路径点「读取」，先看元信息 / 正文预览 / 候选交接值，再决定要不要搭'),
          ), 'simExt', (extRead && extRead.ok) ? 'ok' : 'warn');
        var bindCard = sec('工程适配', bindInfo ? (bindInfo.fileCount + ' 个活文件') : '把真机工程搬进来',
          React.createElement('div', { key: 'b' },
            React.createElement('div', { className: PLUGIN + '-hint', key: 'ext' },
              '从这台机器上的沙箱活文件里挑一份（作者要的「任意本地 .lua 绝对路径」在上面那张独立小卡里）——'),
            React.createElement('div', { className: PLUGIN + '-row', key: 'r1' },
              React.createElement('button', {
                className: PLUGIN + '-act', key: 'scan', disabled: busy,
                title: 'op=handover：扫这台机器上的活文件，并把源码里的候选交接值（local NAME = 大整数）摆出来',
                onClick: function () {
                  engine({ op: 'handover' }).then(function (d) {
                    if (!d) return;
                    setBindInfo(d);
                    setBindPath(d.picked || '');
                    setBindRows(extRowsFromHandover(d));
                    var ci2 = extContainerFromHandover(d);
                    if (ci2) setBindContainer(ci2);
                  });
                },
              }, '扫描活文件'),
              React.createElement('select', {
                className: PLUGIN + '-act', key: 'f', value: bindPath,
                style: { maxWidth: '100%' },
                title: '选一份真机活文件（.lua）。标 ★ 的是「当前正在开发的那张图」',
                onChange: function (e) {
                  var v = e.target.value;
                  setBindPath(v);
                  engine({ op: 'handover', source: v }).then(function (d) {
                    if (!d) return;
                    setBindInfo(d);
                    setBindRows(extRowsFromHandover(d));
                    var ci2 = extContainerFromHandover(d);
                    if (ci2) setBindContainer(ci2);
                  });
                },
              }, (bindInfo && bindInfo.files && bindInfo.files.length)
                ? bindInfo.files.map(function (f) {
                  return React.createElement('option', { key: f.path, value: f.path },
                    (f.current ? '★ ' : '') + f.levelId + ' · ' + f.file + (f.auxiliary ? '（附属）' : ''));
                })
                : [React.createElement('option', { key: 'none', value: '' }, '（还没扫 —— 点左边「扫描活文件」）')])),
            bindRows.length
              ? React.createElement('div', { key: 'r2' },
                React.createElement('div', { className: PLUGIN + '-hint' },
                  '候选交接值（来自脚本源码 local NAME = <大整数>，启发式）：勾上要当模板的，kind 必须你确认 —— 猜错会静默什么都不建'),
                bindRows.map(function (r, i) {
                  return React.createElement('div', { className: PLUGIN + '-row', key: 'c' + r.value, style: { marginTop: '4px' } },
                    React.createElement('label', { className: PLUGIN + '-hint', key: 'lb', style: { display: 'flex', gap: '5px', alignItems: 'center' } },
                      React.createElement('input', {
                        type: 'checkbox', checked: r.on, key: 'ck',
                        onChange: function (e) {
                          var on = e.target.checked;
                          setBindRows(function (prev) { return prev.map(function (x, j) { return j === i ? Object.assign({}, x, { on: on }) : x; }); });
                        },
                      }),
                      r.name + ' = ' + r.value),
                    React.createElement('select', {
                      className: PLUGIN + '-act', key: 'k', value: r.kind,
                      onChange: function (e) {
                        var k = e.target.value;
                        setBindRows(function (prev) { return prev.map(function (x, j) { return j === i ? Object.assign({}, x, { kind: k }) : x; }); });
                      },
                    }, [React.createElement('option', { key: 'none', value: '' }, '不是模板')].concat(kindOpts.map(function (k) {
                      return React.createElement('option', { key: k, value: k }, k);
                    }))));
                }))
              : null,
            React.createElement('div', { className: PLUGIN + '-row', key: 'r3' },
              React.createElement('span', { className: PLUGIN + '-hint', key: 'ch' }, '容器索引：'),
              React.createElement('input', {
                className: PLUGIN + '-act', key: 'ci', value: bindContainer,
                placeholder: '创作者交接的容器节点索引（可空）',
                style: { minWidth: '150px' },
                onChange: function (e) { setBindContainer(e.target.value); },
              }),
              React.createElement('button', {
                className: PLUGIN + '-act ' + PLUGIN + '-primary', key: 'do', disabled: busy || !bindPath,
                title: 'op=bind：建模板（guid 用交接值）+ 挂脚本 + 起一次会话并回「脚本跑没跑、控件建了几个」',
                onClick: function () {
                  var templates = bindRows.filter(function (x) { return x.on && x.kind; })
                    .map(function (x) { return { guid: x.value, kind: x.kind, name: x.name }; });
                  engine({
                    op: 'bind', source: bindPath, templates: templates,
                    containerId: Number(bindContainer) || undefined,
                    keepRunning: true, name: undefined,
                  }).then(function (d) {
                    if (!d) return;
                    setBindRes(d);
                    setLogs(((d.run && d.run.logs) || []).map(function (l) { return (l && l.text) || ''; }));
                    if (d.run) { setRunning(true); setStat({ frame: d.run.frame || 0, time: d.run.time || 0, controls: d.run.controlCount || 0 }); }
                    return refresh();
                  });
                },
              }, '搭进模拟器')),
            bindRes
              ? React.createElement('div', { className: PLUGIN + '-log', key: 'res', style: { maxHeight: '170px' } },
                // ★ 反馈第 5 条起 `op=bind` 默认精简档：`scripts[]` 逐条被省掉 ⇒ 面板改读 `scriptCount`
                //   （否则这里会永远显示"0 个脚本"——回执瘦身不该把面板显示带坏）
                ('搭好了：模板 ' + (bindRes.templateCount || 0) + ' 个 · '
                  + (bindRes.scriptCount != null ? bindRes.scriptCount : (bindRes.scripts || []).length) + ' 个脚本 · '
                  + (bindRes.handover && bindRes.handover.missing && bindRes.handover.missing.length
                    ? '⚠️ 有 ' + bindRes.handover.missing.length + ' 个交接值在源码里找不到（可能交错了）' : '交接值核对：missing 空')
                  + '\n控件（运行时）：' + ((bindRes.run && bindRes.run.controlCount) || 0)
                  + (bindRes.run && bindRes.run.logs && bindRes.run.logs.length ? '\n脚本 print：' : '\n⚠️ 脚本一行都没 print（不等于没跑）')
                  + ((bindRes.run && bindRes.run.logs) || []).slice(-6).map(function (l) { return '\n  ' + l.text; }).join('')))
              : null),
          'simBind', bindRes ? 'ok' : 'warn');

        /* ---------------------------------------------- 验收单（op=cases） */

        var bookCard = sec('验收单', book ? (book.setCount + ' 组') : '人 / AI 读同一份',
          React.createElement('div', { key: 'k' },
            React.createElement('div', { className: PLUGIN + '-row', key: 'r1' },
              React.createElement('button', {
                className: PLUGIN + '-act', key: 'ld', disabled: busy,
                title: 'op=cases action=list：读模拟器工作区的 cases.json',
                onClick: function () { engine({ op: 'cases' }).then(function (d) { if (d) setBook(d); }); },
              }, '读清单'),
              React.createElement('select', {
                className: PLUGIN + '-act', key: 'set',
                value: bookSet || ((book && book.sets && book.sets[0]) ? book.sets[0].set : ''),
                onChange: function (e) { setBookSet(e.target.value); setCaseResults(null); },
              }, (book && book.sets && book.sets.length)
                ? book.sets.map(function (s) { return React.createElement('option', { key: s.set, value: s.set }, s.set + '（' + s.autoCount + ' 自动 / ' + s.manualCount + ' 人工）'); })
                : [React.createElement('option', { key: 'none', value: '' }, '（还没有用例集）')]),
              React.createElement('button', {
                className: PLUGIN + '-act ' + PLUGIN + '-primary', key: 'run', disabled: busy || !(book && book.sets && book.sets.length),
                title: 'op=cases action=run：自动项确定性重放；**人工项不代跑**，只列出来等人打勾',
                onClick: function () {
                  var set = bookSet || ((book && book.sets && book.sets[0]) ? book.sets[0].set : '');
                  engine({ op: 'cases', action: 'run', set: set }).then(function (d) {
                    if (!d) return;
                    setCaseResults(d);
                    setLogs(function (prev) { return prev.concat([d.note || '']); });
                  });
                },
              }, '跑这一组')),
            React.createElement('div', { className: PLUGIN + '-row', key: 'r2' },
              React.createElement('input', {
                className: PLUGIN + '-act', key: 'nm', value: caseName,
                placeholder: '用例名，如「切相后不掉血」', style: { minWidth: '150px' },
                onChange: function (e) { setCaseName(e.target.value); },
              }),
              React.createElement('input', {
                className: PLUGIN + '-act', key: 'ex', value: expectText,
                placeholder: '期望（JSON 数组），如 [{"kind":"log","contains":"就绪"}]',
                style: { minWidth: '190px', flex: '1 1 190px' },
                title: '断言：log{contains} / control{name,field,equals} / count{controlKind,atLeast} / var / signal / tree / lua',
                onChange: function (e) { setExpectText(e.target.value); },
              }),
              React.createElement('button', {
                className: PLUGIN + '-act', key: 'add', disabled: busy || !caseName,
                title: 'op=cases action=add fromHistory:true：把**刚跑过那一局**的操作当成用例的步骤（AI 不用手抄 events）',
                onClick: function () {
                  var set = bookSet || ((book && book.sets && book.sets[0]) ? book.sets[0].set : '');
                  if (!set) { setErr('先给用例集起个名字（用「读清单」后下拉里就会有）'); return; }
                  var expect;
                  try { expect = JSON.parse(expectText); } catch (e) { setErr('期望不是合法 JSON：' + ((e && e.message) || e)); return; }
                  engine({ op: 'cases', action: 'add', set: set, fromHistory: true, cases: [{ name: caseName, expect: expect }] })
                    .then(function (d) { if (d) { setErr(''); setCaseName(''); return engine({ op: 'cases' }).then(function (x) { if (x) setBook(x); }); } });
                },
              }, '存用例（含这一局）'),
              React.createElement('button', {
                className: PLUGIN + '-act', key: 'man', disabled: busy || !caseName || !caseNote,
                title: '存成**人工项**：工具不代跑也不代判，只列出来等人 / 等真机打勾',
                onClick: function () {
                  var set = bookSet || ((book && book.sets && book.sets[0]) ? book.sets[0].set : '');
                  if (!set) { setErr('先给用例集起个名字'); return; }
                  engine({ op: 'cases', action: 'add', set: set, cases: [{ name: caseName, manual: true, note: caseNote }] })
                    .then(function (d) { if (d) { setCaseName(''); setCaseNote(''); return engine({ op: 'cases' }).then(function (x) { if (x) setBook(x); }); } });
                },
              }, '存人工项')),
            React.createElement('div', { className: PLUGIN + '-row', key: 'r3' },
              React.createElement('span', { className: PLUGIN + '-hint', key: 'nh' }, '人工项说明（人要看什么、看到什么算过）：'),
              React.createElement('input', {
                className: PLUGIN + '-act', key: 'nt', value: caseNote,
                placeholder: '如：真机上小人看得见、手不飘',
                style: { minWidth: '200px', flex: '1 1 200px' },
                onChange: function (e) { setCaseNote(e.target.value); },
              })),
            (book && book.sets && book.sets.length)
              ? React.createElement('div', { className: PLUGIN + '-log', key: 'list', style: { maxHeight: '190px' } },
                book.sets.map(function (s) {
                  return s.cases.map(function (c) {
                    var res = null;
                    if (caseResults && caseResults.set === s.set && caseResults.result) {
                      res = (caseResults.result.cases || []).filter(function (x) { return x.name === c.name; })[0] || null;
                    }
                    var mark = c.kind === 'manual' ? '☐' : (res ? (res.passed ? '✅' : '❌') : '·');
                    return '\n' + mark + ' [' + s.set + '] ' + c.name
                      + (c.kind === 'manual' ? '（人工）' + (c.note ? ' — ' + c.note : '') : '（自动 ' + c.asserts + ' 断言）')
                      + (res && !res.passed ? ' ← 没过：' + JSON.stringify(res.results) : '');
                  }).join('');
                }).join(''),
                caseResults
                  ? (caseResults.autoPassed === null ? '\n\n⚠️ 这一组没有自动项（只有人工项）—— 工具不代判'
                    : '\n\n自动项 ' + caseResults.passedCount + '/' + caseResults.autoCount
                    + '；人工项 ' + caseResults.manualCount + ' 条等你打勾' + (caseResults.note ? ' — ' + caseResults.note : ''))
                  : '')
              : null),
          'simCases', caseResults ? (caseResults.autoPassed ? 'ok' : 'warn') : 'warn');

        /**
         * ④ 工程与控件树（**默认折叠**）：工程信息、工程适配（bind）与控件树平时不用盯着看，
         * 展开又会把上面几块挤下去 —— 塞进 `<details>`，要看再点开。
         * （「任意本地 .lua（绝对路径）」原来也塞在这张卡里，2026-09-25 已提到左列最上面那张独立小卡。）
         */
        var engCard = React.createElement('details', { className: PLUGIN + '-sec', key: 'eng' },
          React.createElement('summary', { className: PLUGIN + '-sec-title' }, '④ 工程与控件树 / 工程适配'),          sec('工程', st ? ((st.workspace && st.workspace.name) || '') : '读取中…',
            React.createElement(KVGrid, { rows: rows }), 'simInfo', st ? 'ok' : 'warn'),
          bindCard,
          (st && st.treeCount > 80)
            ? React.createElement('div', { className: PLUGIN + '-hint', key: 'more' }, '只列前 80 个（共 ' + st.treeCount + ' 个）')
            : null,
          React.createElement('div', { key: 'tree' }, treeNodes));

        /**
         * ① 试玩日志（**左列第 2 张卡**，紧跟最上面那张「读本地 .lua（绝对路径）」）。
         *
         * 它原来是「① 画面与日志」：画面（未取图占位 / PNG 预览 / 编辑器画面 / 刷新画面 / 连帧）被作者判为鸡肋
         * —— 真正的画面就在**右列那个试玩页**里（GET /miliastra/play，可点「新窗口 ↗」放大）——
         * 2026-09-25 整块 GUI 删除，这张卡只剩日志（作者一直在用它）。
         * 顺序仍是「最常看的在最上面」：读本地 .lua → 日志 → 操作 → 时间线 → 验收单 → 工程（折叠）。
         */
        var logCard = sec('① 试玩日志', running ? '运行中' : '未开始',
          React.createElement('div', { className: PLUGIN + '-log', key: 'l', style: { maxHeight: '170px' } },
            logs.length ? logs.join('\n') : '（还没有日志：先点「开始试玩」）'), 'simLog', running ? 'ok' : 'warn');

        /**
         * ② 试玩操作（**不再折叠**）：取图入口（编辑器画面 / 刷新画面 / 连帧）删掉之后，
         * 这张卡里留下的都是**非取图**的东西：传输控制（开始/单步/停止）、按键、导出 GIA、浏览器试玩、重置工程。
         * 原来它折在 `<details>` 里，是因为"核心动作在上面 ① 那张卡上"；现在 ① 只讲日志，
         * 传输控制就必须直接看得见 —— 不能再让人先展开折叠卡、再点「开始试玩」。
         */
        var ops = sec('② 试玩操作', running ? '会话运行中' : '未开始',
          React.createElement('div', { key: 'o', style: { display: 'flex', flexDirection: 'column', gap: '5px' } },
            React.createElement('div', { className: PLUGIN + '-hint', key: 'i' },
              '帧 ' + statFrame + ' · 控件 ' + statControls
              + ' · 画面与控制都在右边那个试玩页里（点「新窗口 ↗」可以放大看；面板不再自己取图）'),
            transportRow, keyRow, advActions, fixedCfgRow), 'simOps', running ? 'ok' : 'warn');

        var histCard = sec('③ 操作时间线', hist.length ? '最近 ' + hist.length + ' 步' : '空',
          React.createElement('div', { className: PLUGIN + '-log', key: 'h', style: { maxHeight: '110px' } },
            hist.length
              ? hist.join('\n')
              : '（你在右边试玩页里点 / 按键之后，这里会出现可重放的操作序列 —— AI 用 op=verify fromHistory:true 直接把这一局变成回归用例）'),
          'simHist', hist.length ? 'ok' : 'warn');

        /**
         * **试玩页**（右 2 份，作者要求）：直接 iframe 嵌 `GET /miliastra/play`（PixiJS WebGL，真能玩）。
         * 它跟面板、跟 AI **共用同一个会话与同一份工程** ——
         *   · 人：在页面里点/按键（引擎把这一局记成 history）；
         *   · AI：用 `miliastra_sim op=play`（key/pointer/step）驱动**同一个会话**，页面每 33ms 轮询场景，所以这里会跟着变。
         * 为什么用 iframe 而不是把 pixi 塞进面板：WebGL + 自己的 CSP 处理，独立页最稳。
         * ★ 它**就是**面板里唯一的画面（作者 2026-09-25 把左列那张"画面"卡整块删了）——
         *   所以左列 ② 里也写明了「画面去右边试玩页看，点新窗口 ↗ 放大」。
         */
        var playPane = React.createElement('div', { className: PLUGIN + '-playpane', key: 'P' },
          React.createElement('div', { className: PLUGIN + '-playhead', key: 'h' },
            React.createElement('span', { className: PLUGIN + '-col-head', key: 't' }, '试玩页（WebGL · 人可玩 / AI 可驱动）'),
            React.createElement('span', { className: PLUGIN + '-hint', key: 'i' }, '画面就在这里（面板不再自己取图）· 与 AI 的 miliastra_sim 共用同一个会话；关页面不会停局'),
            React.createElement('span', { className: PLUGIN + '-spacer', key: 'sp' }),
            React.createElement('button', {
              className: PLUGIN + '-act', key: 'rf', title: '重新加载这一页（比如脚本改了要重开一局）',
              onClick: function () { setPlayNonce(function (n) { return n + 1; }); },
            }, '重载页面'),
            React.createElement('a', {
              className: PLUGIN + '-act', key: 'open', href: PREFIX + '/play', target: '_blank', rel: 'noreferrer',
              style: { textDecoration: 'none', display: 'inline-flex', alignItems: 'center' },
              title: '在新标签页打开（全屏玩更舒服）',
            }, '新窗口 ↗')),
          React.createElement('iframe', {
            key: 'f' + playNonce,
            className: PLUGIN + '-playframe',
            src: PREFIX + '/play',
            title: '千星模拟器试玩页（WebGL）',
          }));

        /**
         * ⚠️ **重启提示**：Host 是启动快照 —— 每次重启 `dsh web`，模拟器内存里的工程都回到**出厂默认**
         * （作者 2026-09-24 实测：重启后试玩页里只剩默认的「文本 / 预设按钮 / 五角星」，看着像"什么都没画"）。
         * 这里如实说明，并给一个**一键重搭**（用上次的配方；不自动重搭 —— 那会擅自改工程）。
         */
        var needsRebind = (st && st.factoryDefault === true);
        var bindStrip = needsRebind
          ? React.createElement('div', { className: PLUGIN + '-warn', key: 'warn' },
            React.createElement('span', { key: 't' },
              '⚠️ 当前工程是**出厂默认**（11 个默认控件）—— 重启 `dsh web` 后内存里的工程就是这个，不是你绑过的那份。'),
            (st.lastBind && st.lastBind.scriptName)
              ? React.createElement('button', {
                className: PLUGIN + '-act ' + PLUGIN + '-primary', key: 'rb', disabled: busy,
                title: '用上次的配方重搭：' + (st.lastBind.source || '') + '（交接值也照原样用）',
                onClick: function () {
                  engine({ op: 'bind', last: true, keepRunning: true }).then(function (d) {
                    if (!d) return;
                    setBindRes(d);
                    setLogs(((d.run && d.run.logs) || []).map(function (l) { return (l && l.text) || ''; }));
                    if (d.run) { setRunning(true); setStat({ frame: d.run.frame || 0, time: d.run.time || 0, controls: d.run.controlCount || 0 }); }
                    setPlayNonce(function (n) { return n + 1; });   // 重载 iframe：让它接上新会话
                    return refresh();
                  });
                },
              }, '一键重搭上次：' + st.lastBind.scriptName)
              : React.createElement('span', { className: PLUGIN + '-hint', key: 'n' },
                '还没有可重搭的配方 —— 展开下面的「④ 工程与控件树 / 工程适配」，扫描活文件后搭一次，之后就会记下来。'))
          : null;

        /*
         * 左列顺序 = 「最常看的在最上面」（作者实测反馈「画面在左下角」= 被工程卡挤下去）：
         *   读本地 .lua（绝对路径） → ① 试玩日志 → ② 试玩操作 → ③ 操作时间线 → 验收单 → ④ 工程与控件树（折叠）。
         * 重启提示（bindStrip）插在第 2 位：要一眼看得见，但不能顶掉作者点名的"最顶上"。
         */
        var playsideKids = [extCard, logCard, ops, histCard, bookCard, engCard];
        if (bindStrip) playsideKids.splice(1, 0, bindStrip);

        kids.push(React.createElement('div', { className: PLUGIN + '-simgrid', key: 'grid' },
          React.createElement('div', { className: PLUGIN + '-playside', key: 'L' }, playsideKids),
          playPane));
        return React.createElement('div', { className: PLUGIN + '-simbody' }, kids);
      }

      /** 「模拟器」页 = 全宽面板壳 + 正文（正文 `SimulatorBody` 与侧边栏浮层**同源**，避免两套漂移） */
      function SimulatorView() {
        return React.createElement('div', {
          className: PLUGIN + '-panel ' + PLUGIN + '-inline',
          style: { position: 'relative', width: '100%', minHeight: '100%', maxHeight: 'none', borderRadius: 0, boxShadow: 'none' },
        }, React.createElement(SimulatorBody, {}));
      }

      /* ---------------------------------------------------------------- 入口 */

      function FooterAction(props) {
        var wide = !!(props && props.wide);
        /*
         * ★ 2026-10-01（作者：「我希望插件能一直展示在旁边辅助我」）：开合状态**记住**，且**默认开**。
         * 于是刷新页面/重开 GUI 之后它还在那儿 —— 不用每次去找侧栏那个按钮。
         * 关掉它（×）也会记住：下次不会再自己弹出来打扰。
         */
        var s = React.useState(function () { return panelPref(PANEL_OPEN_KEY, false); });
        var open = s[0]; var setOpen = s[1];
        var rootRef = React.useRef(null);
        React.useEffect(function () { panelPrefSet(PANEL_OPEN_KEY, open); }, [open]);
        return React.createElement('div', { className: PLUGIN + '-root', ref: rootRef },
          React.createElement('button', {
            className: PLUGIN + '-btn' + (wide ? '' : ' ' + PLUGIN + '-rail'),
            title: 'Miliastra Wonderland · 千星奇域',
            'aria-label': '千星奇域',
            onClick: function () { setOpen(!open); },
          },
          React.createElement(Icon, {}),
          wide ? React.createElement('span', { className: PLUGIN + '-label' }, '千星奇域') : null),
          React.createElement(Panel, { open: open, setOpen: setOpen, rootRef: rootRef }));
      }

      exports.name = PLUGIN;
      // 仅供本地渲染测试：把面板组件交出去，好在 **SSR 下真渲染一遍**（空状态），
      // 抓「卡片被写坏 / 少一个孩子」这类一渲染就炸的错。
      exports.__testPanel = Panel;
      // 模拟器视图壳（2026-09-26 起**生产已不再走它**：顶部 tab 撤掉后没有 `inline` 入口了；
      // 暂时留给本地渲染测试，下一次清理时一并删）
      exports.__testSimulatorView = SimulatorView;
      exports.__testSimulatorBody = SimulatorBody;
      // 「任意本地 .lua（绝对路径）」的两个请求体 —— source 必须是**粘贴的那个路径**
      // （串成活文件路径就会「看起来读了、其实读的是另一个文件」，且不报错），所以单独回归
      exports.__testExternalLuaReadRequests = externalLuaReadRequests;
      exports.__testExternalLuaBindArgs = externalLuaBindArgs;
      // 候选表的三件事（预勾选 / 容器预填 / 空候选指路 + 缺什么）是纯函数，单独回归
      exports.__testExtRowsFromHandover = extRowsFromHandover;
      exports.__testExtContainerFromHandover = extContainerFromHandover;
      exports.__testExtCandidatesLine = extCandidatesLine;
      exports.__testExtBindReadyHint = extBindReadyHint;
      // 画布点击的坐标换算（纯函数）—— 写错会「点哪儿都点不到」且不报错，必须单独回归
      exports.__testStagePoint = stagePointFromEvent;
      exports.__testHistLine = histLine;
      // 日志格式化的两个纯函数也交出去 —— 拆分/判色这些逻辑值得单独回归（不必渲染整面板）。
      exports.__testParseLogRecord = parseLogRecord;
      exports.__testToLogRows = toLogRows;
      exports.__testLogRow = LogRow;
      // 「试玩完自动取」的判据是纯函数 —— 定时器不好测，判据必须能测。
      exports.__testAutoFollowStep = autoFollowStep;
      // 「开跑 → 该不该自动截图」也是纯函数判据，同样必须能回归
      exports.__testPtStep = ptStep;
      exports.__testShortSessionName = shortSessionName;
      exports.__testAutoPhaseMark = autoPhaseMark;
      /*
       * 网格计算（第六页）的全程都是**纯函数**：参数校验 / 残格判定 / 双向换算 / 速查表。
       * 这几条最容易"看着对、其实差一格"（而面板不会报错），所以全部交出去单独回归。
       */
      exports.__testGridNum = gridNum;
      exports.__testGridPlan = gridPlan;
      exports.__testGridAxisLine = gridAxisLine;
      exports.__testGridSummaryLines = gridSummaryLines;
      exports.__testGridCellToPixel = gridCellToPixel;
      exports.__testGridPixelToCell = gridPixelToCell;
      exports.__testGridLines = gridLines;
      exports.__testGridTable = gridTable;
      exports.__testGridTableTsv = gridTableTsv;
      exports.__testGridCopyText = gridCopyText;
      exports.__testGridLabels = gridLabels;
      exports.__testGridPointLine = gridPointLine;
      // 多选：切换 / 逐行数据 / 「一起复制」的 Lua 片段（格式由作者给定）全是纯函数
      exports.__testGridSelLua = gridSelLua;
      exports.__testGridSelKey = gridSelKey;
      exports.__testGridSelToggle = gridSelToggle;
      exports.__testGridSelAdd = gridSelAdd;
      exports.__testGridSelPrune = gridSelPrune;
      exports.__testGridSelRows = gridSelRows;
      // 四角锚点 + 滚轮缩放夹取
      exports.__testGridAnchors = GRID_ANCHORS;
      exports.__testGridAnchorName = gridAnchorName;
      exports.__testGridAnchorPoint = gridAnchorPoint;
      exports.__testGridZoomClamp = gridZoomClamp;
      // 右键标记颜色（作者给定的导出片段格式）
      exports.__testGridColors = GRID_COLORS;
      exports.__testGridColorById = gridColorById;
      exports.__testGridColorToggle = gridColorToggle;
      exports.__testGridColorOf = gridColorOf;
      // 缓存：读回 null 也**不能**当成"读到了空对象"（隐私模式/被禁都只意味着没缓存）
      exports.__testStoreGet = storeGet;
      exports.__testStoreSet = storeSet;
      exports.__testGridPresets = GRID_PRESETS;
      // ⚠️ **必须声明 `slots`**。cordis 的服务代理是受限的：不声明就直接读 `ctx.slots`
      //    会抛 `cannot get property "slots" without inject`，而且会让**整条 loader entry 失败**
      //    （表现为「插件没生效」+ 页面上一条我们的日志都没有）。
      //    声明后 cordis 会等该服务就绪再调 apply。
      exports.inject = ['slots'];
      exports.apply = function (ctx) {
        var disposers = [];
        var push = function (d) { if (typeof d === 'function') disposers.push(d); };

        // 服务一律走「安全读」：即使 ctx 是受限代理也不会抛。
        var slotsSvc = null;
        try { slotsSvc = (ctx && ctx.slots) || null; } catch (e) { slotsSvc = null; }

        try {
          console.log('[' + PLUGIN + '] apply 运行中：react=' + (React ? '有' : '无')
            + '  ctx.slots=' + (slotsSvc ? '有' : '无')
            + '  ctx.slots.inject=' + (slotsSvc && typeof slotsSvc.inject === 'function' ? '有' : '无')
            + '  ctx.effect=' + (ctx && typeof ctx.effect === 'function' ? '有' : '无'));

          if (!React) { console.warn('[' + PLUGIN + '] react 不可用，面板未注册'); }
          else if (!slotsSvc || typeof slotsSvc.inject !== 'function') {
            console.warn('[' + PLUGIN + '] slots 服务不可用，面板未注册');
          } else {
            push(typeof ctx.effect === 'function' ? ctx.effect(injectStyle, PLUGIN + ': style') : injectStyle());

            var declared = false;
            push(slotsSvc.inject('sidebar.footer.action', function () {
              declared = true;
              console.log('[' + PLUGIN + '] 槽位 sidebar.footer.action 的声明到达 —— 正在注册入口');
              var unregister = slotsSvc.register({
                name: 'sidebar.footer.action',
                id: PLUGIN,
                order: 120,
              }, FooterAction);
              console.log('[' + PLUGIN + '] 入口已注册到 sidebar.footer.action（id=' + PLUGIN + ', order=120）');
              return function () { try { unregister(); } catch (e) { /* ignore */ } };
            }));

            /*
             * ★ 2026-09-26（作者要求）：这里**曾经**把三个 tab（初级功能 / 高级功能 / 模拟器）
             *   注册进官方槽位 `conversation.view`（DSH 的会话区按它渲染顶部 tab，
             *   与官方「对话 / 轨迹」并列）。现在**整段撤掉**：
             *   · 插件 GUI 只有一处入口 = 侧边栏左下角「千星奇域」→ 浮层面板；
             *   · 三页切换在**面板内部**（`panelTab`），不占会话区顶部。
             *   ⇒ 不再调用 `slotsSvc.inject('conversation.view', …)`；`registerView` 与 `VIEW_TABS` 一并删除。
             *   ⚠️ 别再"顺手加回来"：`tests/client-render-test.mjs` 有反向绊线断言未注册该槽位。
             */

            // 诊断计时器：3 秒内没等到槽位声明 = 这一版壳没渲染该槽位（或名字变了）。
            // 这是 client 半边最容易"静默失败"的一条路，所以显式报出来。
            var probeTimer = setTimeout(function () {
              if (!declared) {
                console.warn('[' + PLUGIN + '] 3 秒内没等到 sidebar.footer.action 的声明 —— '
                  + '这一版壳可能根本没渲染该槽位，或槽位名变了。'
                  + '可跑 window.__DSH_BOOT__.entries.map(e=>e.id) 确认 bundle 是否已进启动图。');
              }
            }, 3000);
            push(function () { clearTimeout(probeTimer); });
          }
        } catch (e) {
          // 绝不 throw：Client 半边抛错会让整个 Web 壳起不来
          console.warn('[' + PLUGIN + '] 面板注册失败：', e);
        }

        // 返回聚合 cleanup：既满足宿主 ctx.effect 的回收，也让「卸载后重挂不留幽灵」可被自测验证。
        return function () {
          for (var i = disposers.length - 1; i >= 0; i -= 1) {
            try { disposers[i](); } catch (e) { /* ignore */ }
          }
          disposers.length = 0;
        };
      };

      return module.exports;
    },
  });
})();
