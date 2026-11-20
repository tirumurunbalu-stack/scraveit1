import {requireAdminSession, signOutUser, callFunction} from "../assets/firebase-client.js?v=5";

// Owner's test accounts and test stores (testAccounts callable, owner claim only; private/testAccounts).

const LISTS = ["customers", "deliveryPartners", "restaurants"];
let data = null;
let saving = false;

function toast(message, kind) {
  const node = document.createElement("div");
  node.className = "toast " + (kind || "");
  node.textContent = message;
  document.getElementById("toast-stack").appendChild(node);
  setTimeout(() => node.remove(), 4200);
}

function esc(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"}[c]));
}

function render() {
  for (const name of LISTS) {
    const box = document.querySelector(`[data-list="${name}"] .list`);
    const emails = data[name] || [];
    box.innerHTML = emails.length ? emails.map((email) => {
      const ok = data.signedUp && data.signedUp[email];
      return `<div class="item"><span class="grow">${esc(email)}</span>` +
        `<span class="badge ${ok ? "yes" : "no"}">${ok ? "Signed up" : "Not signed up yet"}</span>` +
        `<button class="btn btn-danger" data-remove="${esc(email)}" data-from="${name}" type="button">Remove</button></div>`;
    }).join("") : `<p class="empty">None yet.</p>`;
  }
  const picked = new Set(data.storeIds || []);
  document.getElementById("stores").innerHTML = (data.stores || []).map((store) =>
    `<label class="store"><input type="checkbox" data-store="${esc(store.id)}" ${picked.has(store.id) ? "checked" : ""}>` +
    `<span class="grow">${esc(store.name)} <small>&middot; ${esc(store.kind)}${store.open ? " &middot; open" : ""}</small></span></label>`).join("") ||
    `<p class="empty">No stores.</p>`;
  document.getElementById("saved").textContent = data.updatedAt ?
    "Last saved " + new Date(data.updatedAt).toLocaleString("en-IN", {dateStyle: "medium", timeStyle: "short"}) : "";
}

async function save(next, message) {
  if (saving) return;
  saving = true;
  for (const b of document.querySelectorAll(".ta button, .ta input")) b.disabled = true;
  try {
    data = await callFunction("testAccounts", {save: {
      customers: next.customers, deliveryPartners: next.deliveryPartners,
      restaurants: next.restaurants, storeIds: next.storeIds,
    }});
    render();
    toast(message, "success");
  } catch (error) {
    toast(error.message, "danger");
    render();
  } finally {
    saving = false;
    for (const b of document.querySelectorAll(".ta button, .ta input")) b.disabled = false;
  }
}

function copy() {
  return {
    customers: [...(data.customers || [])], deliveryPartners: [...(data.deliveryPartners || [])],
    restaurants: [...(data.restaurants || [])], storeIds: [...(data.storeIds || [])],
  };
}

async function load() {
  try {
    data = await callFunction("testAccounts", {});
    render();
  } catch (error) {
    document.getElementById("stores").innerHTML = `<p class="empty">${esc(error.message)}</p>`;
  }
}

const session = await requireAdminSession();
if (session) {
  document.getElementById("app-shell").hidden = false;
  const who = document.getElementById("sidebar-who");
  if (who && session.user) who.textContent = session.user.email || "";
  document.getElementById("signout-btn").addEventListener("click", async () => {
    await signOutUser();
    window.location.replace("../");
  });
  for (const name of LISTS) {
    const form = document.querySelector(`[data-list="${name}"] .add`);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!data) return;
      const input = form.querySelector("input");
      const email = input.value.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast("Type a full email address.", "danger"); return; }
      const next = copy();
      if (next[name].includes(email)) { toast("Already in the list.", "danger"); return; }
      next[name].push(email);
      input.value = "";
      save(next, email + " added.");
    });
  }
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove]");
    if (!button || !data) return;
    const next = copy();
    next[button.dataset.from] = next[button.dataset.from].filter((email) => email !== button.dataset.remove);
    save(next, button.dataset.remove + " removed.");
  });
  document.addEventListener("change", (event) => {
    const box = event.target.closest("[data-store]");
    if (!box || !data) return;
    const next = copy();
    next.storeIds = box.checked ? [...new Set([...next.storeIds, box.dataset.store])] : next.storeIds.filter((id) => id !== box.dataset.store);
    const name = (data.stores.find((s) => s.id === box.dataset.store) || {}).name || "Store";
    save(next, name + (box.checked ? " is now a test store." : " is a real store again."));
  });
  load();
}
