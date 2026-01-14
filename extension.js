const STAR_ATTR = "data-bcp-star";
const SORT_CONTROLS_ATTR = "data-bcp-sort-controls";
const SORT_BUTTON_ATTR = "data-bcp-sort-button";
const SEPARATOR_ATTR = "data-bcp-separator";
const SORT_MODE_DEFAULT = "Roam native";
const SORT_MODES = new Set(["Roam native", "A → Z", "Z → A"]);
let baseIndexMap = new Map();

let extensionAPIRef = null;
let pinnedSet = new Set();
let sessionSortMode = null;
let paletteOpen = false;
let portalEl = null;
let menuObservedEl = null;
let portalObserver = null;
let menuObserver = null;
let menuFinderObserver = null;
let debounceTimer = null;
let reorderInProgress = false;
let decorateInProgress = false;

function normalizeText(text) {
    return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function loadPinnedSet(extensionAPI) {
    const raw = extensionAPI.settings.get("bcp_pinned");
    if (!raw || typeof raw !== "string") {
        return new Set();
    }
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            return new Set(parsed.filter((item) => typeof item === "string"));
        }
    } catch (err) {
        return new Set();
    }
    return new Set();
}

function savePinnedSet(extensionAPI, set) {
    extensionAPI.settings.set("bcp_pinned", JSON.stringify([...set]));
}

function getGlobalSortMode() {
    if (!extensionAPIRef) {
        return SORT_MODE_DEFAULT;
    }
    const raw = extensionAPIRef.settings.get("bcp_sort_mode");
    if (SORT_MODES.has(raw)) {
        return raw;
    }
    return SORT_MODE_DEFAULT;
}

function getEffectiveSortMode() {
  return sessionSortMode ?? getGlobalSortMode();
}

function findPalettePortal() {
    return document.querySelector(".rm-modal-portal--command-palette");
}

function computeItemKey(itemEl) {
    const labelSpan = itemEl.querySelector(".rm-command-palette__label span");
    const rawLabel = labelSpan ? labelSpan.innerText.trim() : "";
    if (!rawLabel) {
        return { key: null, labelLower: "" };
    }

    const shortcutEls = itemEl.querySelectorAll(".rm-command-palette__shortcut");
    const shortcutText = Array.from(shortcutEls)
        .map((el) => el.innerText.trim())
        .filter(Boolean)
        .join(",");

    const labelNorm = normalizeText(rawLabel);
    if (!labelNorm) {
        return { key: null, labelLower: "" };
    }

    const key = shortcutText
        ? `${labelNorm}||${normalizeText(shortcutText)}`
        : labelNorm;

    return { key, labelLower: labelNorm };
}

function setStarState(starEl, pinned) {
    const nextText = pinned ? "★" : "☆";
    if (starEl.textContent !== nextText) {
        starEl.textContent = nextText;
    }
    const nextPinned = pinned ? "1" : "0";
    if (starEl.getAttribute("data-pinned") !== nextPinned) {
        starEl.setAttribute("data-pinned", nextPinned);
    }
    const nextPressed = pinned ? "true" : "false";
    if (starEl.getAttribute("aria-pressed") !== nextPressed) {
        starEl.setAttribute("aria-pressed", nextPressed);
    }
    const nextLabel = pinned ? "Unpin command" : "Pin command";
    if (starEl.getAttribute("aria-label") !== nextLabel) {
        starEl.setAttribute("aria-label", nextLabel);
    }
    starEl.title = nextLabel;
}

function ensureStar(itemEl, pinned, key) {
    const labelContainer = itemEl.querySelector(".rm-command-palette__label");
    if (!labelContainer) {
        return;
    }

    let starEl = labelContainer.querySelector(`[${STAR_ATTR}="1"]`);
    if (!starEl) {
        starEl = document.createElement("button");
        starEl.type = "button";
        starEl.className = "bcp-star";
        starEl.setAttribute(STAR_ATTR, "1");
        starEl.addEventListener("mousedown", (event) => {
            event.preventDefault();
            event.stopPropagation();
        });
        starEl.addEventListener("click", onStarClick);
        labelContainer.prepend(starEl);
    }

    if (key) {
        starEl.dataset.bcpKey = key;
    }

    setStarState(starEl, pinned);
}

function onStarClick(event) {
    event.preventDefault();
    event.stopPropagation();

    const starEl = event.currentTarget;
    const itemEl = starEl.closest(".rm-menu-item.bp3-menu-item");
    if (!itemEl) {
        return;
    }

    let key = itemEl.dataset.bcpKey || starEl.dataset.bcpKey;
    if (!key) {
        const computed = computeItemKey(itemEl);
        key = computed.key;
        if (!key) {
            return;
        }
    }

    const wasPinned = pinnedSet.has(key);
    if (wasPinned) {
        pinnedSet.delete(key);
    } else {
        pinnedSet.add(key);
    }
    savePinnedSet(extensionAPIRef, pinnedSet);
    setStarState(starEl, !wasPinned);
    scheduleDecorate();
}

function compareLabels(a, b, direction) {
    const aLabel = a.labelLower;
    const bLabel = b.labelLower;
    if (!aLabel && !bLabel) {
        return 0;
    }
    if (!aLabel) {
        return 1;
    }
    if (!bLabel) {
        return -1;
    }
    return direction * aLabel.localeCompare(bLabel);
}

function reorderMenu(menuEl, items) {
    reorderInProgress = true;
    const pinnedItems = items.filter((item) => item.key && pinnedSet.has(item.key));
    const unpinnedItems = items.filter(
        (item) => !item.key || !pinnedSet.has(item.key),
    );
    const needSeparator = pinnedItems.length > 0 && unpinnedItems.length > 0;
    let separatorEl = menuEl.querySelector(`[${SEPARATOR_ATTR}="1"]`);
    if (needSeparator) {
        if (!separatorEl) {
            separatorEl = document.createElement("div");
            separatorEl.className = "bp3-menu-divider bcp-menu-divider";
            separatorEl.setAttribute(SEPARATOR_ATTR, "1");
            separatorEl.setAttribute("role", "separator");
        }
    } else if (separatorEl) {
        separatorEl.remove();
        separatorEl = null;
    }

    pinnedItems.sort((a, b) => {
        const labelCompare = compareLabels(a, b, 1);
        if (labelCompare !== 0) {
            return labelCompare;
        }
        return a.baseIndex - b.baseIndex;
    });

    const sortMode = getEffectiveSortMode();
    if (sortMode === "A → Z") {
        unpinnedItems.sort((a, b) => {
            const labelCompare = compareLabels(a, b, 1);
            if (labelCompare !== 0) {
                return labelCompare;
            }
            return a.baseIndex - b.baseIndex;
        });
    } else if (sortMode === "Z → A") {
        unpinnedItems.sort((a, b) => {
            const labelCompare = compareLabels(a, b, -1);
            if (labelCompare !== 0) {
                return labelCompare;
            }
            return a.baseIndex - b.baseIndex;
        });
    } else {
        unpinnedItems.sort((a, b) => a.baseIndex - b.baseIndex);
    }

    const desiredOrder = [
        ...pinnedItems.map((item) => item.el),
        ...(needSeparator && separatorEl ? [separatorEl] : []),
        ...unpinnedItems.map((item) => item.el),
    ];
    const currentOrder = Array.from(menuEl.children).filter(
        (el) =>
            el.matches(".rm-menu-item.bp3-menu-item") ||
            el.getAttribute(SEPARATOR_ATTR) === "1",
    );
    const isSameOrder =
        desiredOrder.length === currentOrder.length &&
        desiredOrder.every((el, idx) => el === currentOrder[idx]);
    if (isSameOrder) {
        reorderInProgress = false;
        return;
    }

    const fragment = document.createDocumentFragment();
    desiredOrder.forEach((el) => fragment.appendChild(el));
    menuEl.appendChild(fragment);
    reorderInProgress = false;
}

function decorateAndApplyPinning(targetPortalEl) {
    if (!targetPortalEl) {
        return;
    }
    const menuEl = targetPortalEl.querySelector(".rm-command-palette__menu");
    if (!menuEl) {
        return;
    }

    if (decorateInProgress) {
        return;
    }
    decorateInProgress = true;

    if (menuObserver) {
        menuObserver.disconnect();
    }
    attachMenuObserver(targetPortalEl);
    ensureSortControls(targetPortalEl);

    const items = Array.from(
        menuEl.querySelectorAll(".rm-menu-item.bp3-menu-item"),
    );
    const itemsMeta = [];

    items.forEach((itemEl, index) => {
        const { key, labelLower } = computeItemKey(itemEl);
        if (key) itemEl.dataset.bcpKey = key;

        let baseIndex = index;
        if (key) {
            const existing = baseIndexMap.get(key);
            if (typeof existing === "number") {
                baseIndex = existing;
            } else {
                baseIndexMap.set(key, index);
                baseIndex = index;
            }
        }

        const isPinned = key ? pinnedSet.has(key) : false;
        ensureStar(itemEl, isPinned, key);

        itemsMeta.push({ el: itemEl, key, labelLower, index, baseIndex });
    });

    reorderMenu(menuEl, itemsMeta);
    updateSortControlsState(targetPortalEl);
    if (menuObserver) {
        menuObserver.disconnect();
        menuObserver.observe(menuEl, { childList: true, subtree: false });
    }
    decorateInProgress = false;
}

function scheduleDecorate() {
    if (decorateInProgress) {
        return;
    }
    if (debounceTimer) {
        cancelAnimationFrame(debounceTimer);
    }
    debounceTimer = requestAnimationFrame(() => {
        debounceTimer = null;
        decorateAndApplyPinning(portalEl);
    });
}

function attachMenuObserver(targetPortalEl) {
    const menuEl = targetPortalEl.querySelector(".rm-command-palette__menu");
    if (menuEl) {
        if (menuObservedEl !== menuEl) {
            if (menuObserver) {
                menuObserver.disconnect();
            }
            menuObserver = new MutationObserver(() => {
                if (!reorderInProgress) {
                    scheduleDecorate();
                }
            });
            menuObserver.observe(menuEl, { childList: true, subtree: false });
            menuObservedEl = menuEl;
        }
        return;
    }

    if (!menuFinderObserver) {
        menuFinderObserver = new MutationObserver(() => {
            const foundMenuEl =
                targetPortalEl.querySelector(".rm-command-palette__menu");
            if (foundMenuEl) {
                menuFinderObserver.disconnect();
                menuFinderObserver = null;
                attachMenuObserver(targetPortalEl);
                ensureSortControls(targetPortalEl);
                scheduleDecorate();
            }
        });
        menuFinderObserver.observe(targetPortalEl, { childList: true, subtree: true });
    }
}

function ensureSortControls(targetPortalEl) {
    if (!targetPortalEl) {
        return;
    }
    const footerEl = targetPortalEl.querySelector(".rm-command-palette__footer");
    if (!footerEl) {
        return;
    }

    let controlsEl = footerEl.querySelector(`[${SORT_CONTROLS_ATTR}="1"]`);
    if (controlsEl) {
        return;
    }

    controlsEl = document.createElement("div");
    controlsEl.className = "bcp-sort-controls";
    controlsEl.setAttribute(SORT_CONTROLS_ATTR, "1");

    const labelEl = document.createElement("span");
    labelEl.className = "bcp-sort-label";
    labelEl.textContent = "Sort:";
    controlsEl.appendChild(labelEl);

    const buttons = [
        { label: "Roam", mode: "Roam native", tooltip: "Use Roam native ordering" },
        { label: "A → Z", mode: "A → Z", tooltip: "Sort unpinned commands A → Z" },
        { label: "Z → A", mode: "Z → A", tooltip: "Sort unpinned commands Z → A" },
    ];

    buttons.forEach(({ label, mode, tooltip }) => {
        const buttonEl = document.createElement("button");
        buttonEl.type = "button";
        buttonEl.className = "bcp-sort-button";
        buttonEl.textContent = label;
        buttonEl.setAttribute(SORT_BUTTON_ATTR, "1");
        buttonEl.dataset.bcpSort = mode;
        buttonEl.title = tooltip;
        buttonEl.setAttribute("aria-label", tooltip);
        buttonEl.addEventListener("mousedown", (event) => {
            event.preventDefault();
            event.stopPropagation();
        });
        buttonEl.addEventListener("click", onSortButtonClick);
        controlsEl.appendChild(buttonEl);
    });

    footerEl.appendChild(controlsEl);
}

function updateSortControlsState(targetPortalEl) {
  if (!targetPortalEl) return;

  const controlsEl = targetPortalEl.querySelector(`[${SORT_CONTROLS_ATTR}="1"]`);
  if (!controlsEl) return;

  const buttons = Array.from(
    controlsEl.querySelectorAll(`[${SORT_BUTTON_ATTR}="1"]`)
  );

  const effectiveMode = getEffectiveSortMode();

  buttons.forEach((buttonEl) => {
    const mode = buttonEl.dataset.bcpSort;
    const isActive = mode === effectiveMode;
    buttonEl.setAttribute("aria-pressed", isActive ? "true" : "false");
    buttonEl.setAttribute("data-active", isActive ? "1" : "0");
  });
}


function onSortButtonClick(event) {
  event.preventDefault();
  event.stopPropagation();

  const buttonEl = event.currentTarget;
  const mode = buttonEl.dataset.bcpSort;

  if (SORT_MODES.has(mode)) {
    sessionSortMode = mode;
    updateSortControlsState(portalEl);
    scheduleDecorate();
  }
}

function onPaletteOpen(nextPortalEl) {
  if (paletteOpen) return;
  paletteOpen = true;
  portalEl = nextPortalEl;
  pinnedSet = loadPinnedSet(extensionAPIRef);
  sessionSortMode = getGlobalSortMode();
  baseIndexMap = new Map();
  attachMenuObserver(nextPortalEl);
  ensureSortControls(nextPortalEl);
  scheduleDecorate();
}

function onPaletteClose() {
    paletteOpen = false;
    portalEl = null;
    sessionSortMode = null;
    baseIndexMap = new Map();
    menuObservedEl = null;
    if (menuObserver) {
        menuObserver.disconnect();
        menuObserver = null;
    }
    if (menuFinderObserver) {
        menuFinderObserver.disconnect();
        menuFinderObserver = null;
    }
    if (debounceTimer) {
        cancelAnimationFrame(debounceTimer);
        debounceTimer = null;
    }
}

function handlePortalCheck() {
    const portal = findPalettePortal();
    if (portal && !paletteOpen) {
        onPaletteOpen(portal);
    } else if (!portal && paletteOpen) {
        onPaletteClose();
    }
}

function nodeContainsPortal(node) {
    if (!node || node.nodeType !== 1) return false;
    const el = /** @type {HTMLElement} */ (node);
    return (
        el.classList?.contains("rm-modal-portal--command-palette") ||
        !!el.querySelector?.(".rm-modal-portal--command-palette")
    );
}

let portalCheckRaf = null;
function schedulePortalCheck() {
    if (portalCheckRaf) return;
    portalCheckRaf = requestAnimationFrame(() => {
        portalCheckRaf = null;
        handlePortalCheck();
    });
}

function startPortalObserver() {
    if (portalObserver) return;

    portalObserver = new MutationObserver((mutations) => {
        if (paletteOpen) {
            if (portalEl && !document.body.contains(portalEl)) {
                onPaletteClose();
            }
            return;
        }

        for (const m of mutations) {
            for (const n of m.addedNodes) {
                if (nodeContainsPortal(n)) {
                    schedulePortalCheck();
                    return;
                }
            }
        }
    });

    portalObserver.observe(document.body, { childList: true, subtree: true });
    handlePortalCheck();
}


function stopPortalObserver() {
    if (portalObserver) {
        portalObserver.disconnect();
        portalObserver = null;
    }
}

export default {
    onload({ extensionAPI }) {
        extensionAPIRef = extensionAPI;
        pinnedSet = loadPinnedSet(extensionAPIRef);

        extensionAPI.settings.panel.create({
            tabTitle: "Better Command Palette",
            settings: [
                {
                    id: "bcp_sort_mode",
                    name: "Sort mode",
                    description:
                        "How to sort unpinned commands in the command palette.",
                    action: {
                        type: "select",
                        items: [
                            "Roam native", "A → Z", "Z → A"
                        ],
                    },
                },
            ],
        });

        startPortalObserver();
    },
    onunload() {
        onPaletteClose();
        stopPortalObserver();
    },
};
