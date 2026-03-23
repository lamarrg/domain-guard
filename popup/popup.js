"use strict";

document.getElementById("btn-sidebar").addEventListener("click", async () => {
  console.log("[DomainGuard] Opening sidebar");
  await browser.sidebarAction.open();
  window.close();
});

document.getElementById("btn-window").addEventListener("click", async () => {
  console.log("[DomainGuard] Opening detached window");
  await browser.windows.create({
    url: browser.runtime.getURL("panel/panel.html"),
    type: "popup",
    width: 400,
    height: 600,
  });
  window.close();
});
