import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";

// 代管平台可能在送出的 HTML 裡插入不屬於本專案的節點（Netlify 會在 <head> 內
// 插入一段 HTML 註解）。React 是對整份文件做 hydration，<head> 裡多出這些節點會被
// 判定為伺服器與用戶端內容不一致（React error #418）。hydration 前先把 <head> 內的
// 註解與純空白文字節點移除；<head> 內這兩種節點本來就不影響頁面。
for (const node of Array.from(document.head.childNodes)) {
  const isComment = node.nodeType === Node.COMMENT_NODE;
  const isBlankText = node.nodeType === Node.TEXT_NODE && !node.textContent?.trim();
  if (isComment || isBlankText) node.remove();
}

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter />
    </StrictMode>,
  );
});
