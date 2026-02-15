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
let decorateRaf = null;
let decoratePending = false;
let reorderInProgress = false;
let decorateInProgress = false;
let paletteKeydownHandler = null;
let paletteKeydownTarget = null;
let needsInitialActive = false;
let lastActiveKey = null;
let menuClickHandler = null;
let menuClickTarget = null;
let menuVersion = 0;
let keydownCacheVersion = -1;
let keydownCacheMenuEl = null;
let keydownVisibleItems = [];
const itemMetaCache = new WeakMap();

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
    const cached = itemMetaCache.get(itemEl) || {};
    let labelSpan = cached.labelSpan;
    if (!labelSpan || !itemEl.contains(labelSpan)) {
        labelSpan = itemEl.querySelector(".rm-command-palette__label span");
    }
    const rawLabel = labelSpan ? (labelSpan.textContent || "").trim() : "";
    if (!rawLabel) {
        itemMetaCache.set(itemEl, {
            ...cached,
            labelSpan,
            rawLabel: "",
            shortcutText: "",
            shortcutNorm: "",
            labelLower: "",
            key: null,
        });
        return { key: null, labelLower: "" };
    }

    const labelNorm = normalizeText(rawLabel);
    if (!labelNorm) {
        return { key: null, labelLower: "" };
    }

    let shortcutEls = cached.shortcutEls;
    if (
        !Array.isArray(shortcutEls) ||
        shortcutEls.some((el) => !itemEl.contains(el))
    ) {
        shortcutEls = Array.from(
            itemEl.querySelectorAll(".rm-command-palette__shortcut"),
        );
    }
    const shortcutText = shortcutEls
        .map((el) => (el.textContent || "").trim())
        .filter(Boolean)
        .join(",");
    const shortcutNorm = shortcutText ? normalizeText(shortcutText) : "";

    if (
        cached.key &&
        cached.rawLabel === rawLabel &&
        cached.shortcutText === shortcutText
    ) {
        return { key: cached.key, labelLower: cached.labelLower };
    }

    const key = shortcutNorm ? `${labelNorm}||${shortcutNorm}` : labelNorm;
    itemEl.dataset.bcpLabelLower = labelNorm;
    itemEl.dataset.bcpShortcutLower = shortcutNorm;
    itemMetaCache.set(itemEl, {
        ...cached,
        labelSpan,
        shortcutEls,
        rawLabel,
        shortcutText,
        shortcutNorm,
        labelLower: labelNorm,
        key,
    });

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
    const cached = itemMetaCache.get(itemEl) || {};
    let labelContainer = cached.labelContainer;
    if (!labelContainer || !itemEl.contains(labelContainer)) {
        labelContainer = itemEl.querySelector(".rm-command-palette__label");
    }
    if (!labelContainer) {
        return;
    }

    let starEl = cached.starEl;
    if (!starEl || !labelContainer.contains(starEl)) {
        starEl = labelContainer.querySelector(`[${STAR_ATTR}="1"]`);
    }
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

    const nextPinned = pinned ? "1" : "0";
    if (
        starEl.getAttribute("data-pinned") !== nextPinned ||
        (key && starEl.dataset.bcpKey !== key)
    ) {
        setStarState(starEl, pinned);
    }

    itemMetaCache.set(itemEl, {
        ...cached,
        labelContainer,
        starEl,
    });
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
    const wasReordered = menuEl.dataset.bcpReordered === "1";
    const pinnedItems = items.filter((item) => item.key && pinnedSet.has(item.key));
    const unpinnedItems = items.filter(
        (item) => !item.key || !pinnedSet.has(item.key),
    );
    const sortMode = getEffectiveSortMode();
    const hasCustomOrder = pinnedItems.length > 0 || sortMode !== SORT_MODE_DEFAULT;
    const nextReordered = hasCustomOrder ? "1" : "0";
    if (menuEl.dataset.bcpReordered !== nextReordered) {
        menuEl.dataset.bcpReordered = nextReordered;
    }
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

    if (!hasCustomOrder && !wasReordered) {
        reorderInProgress = false;
        return;
    }

    pinnedItems.sort((a, b) => {
        const labelCompare = compareLabels(a, b, 1);
        if (labelCompare !== 0) {
            return labelCompare;
        }
        return a.baseIndex - b.baseIndex;
    });

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

function scrollActiveItemIntoView(menuEl) {
    const activeItem = menuEl?.querySelector(".rm-menu-item--active");
    if (activeItem) {
        activeItem.scrollIntoView({ block: "nearest" });
    }
}

function normalizeActiveItem(menuEl) {
    if (!menuEl) return;
    const activeItems = Array.from(
        menuEl.querySelectorAll(".rm-menu-item--active"),
    );
    if (activeItems.length <= 1) return;
    let keep = null;
    if (lastActiveKey) {
        keep =
            activeItems.find((item) => item.dataset.bcpKey === lastActiveKey) || null;
    }
    if (!keep) {
        [keep] = activeItems;
    }
    activeItems.forEach((item) => {
        if (item !== keep) {
            item.classList.remove("rm-menu-item--active");
        }
    });
    if (keep) {
        keep.scrollIntoView({ block: "nearest" });
    }
}

function getVisibleItemsForKeydown(menuEl) {
    if (!menuEl) return [];

    if (
        !decoratePending &&
        keydownCacheMenuEl === menuEl &&
        keydownCacheVersion === menuVersion
    ) {
        return keydownVisibleItems;
    }

    keydownVisibleItems = Array.from(
        menuEl.querySelectorAll(".rm-menu-item.bp3-menu-item"),
    ).filter((item) => item.getClientRects().length > 0);
    keydownCacheMenuEl = menuEl;
    keydownCacheVersion = menuVersion;
    return keydownVisibleItems;
}

function handlePaletteKeydown(event) {
    if (!paletteOpen || !portalEl) {
        return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
        return;
    }

    const menuEl = portalEl.querySelector(".rm-command-palette__menu");
    if (!menuEl || menuEl.dataset.bcpReordered !== "1") {
        return;
    }

    const items = getVisibleItemsForKeydown(menuEl);
    if (items.length === 0) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();

    let activeIndex = items.findIndex((item) =>
        item.classList.contains("rm-menu-item--active"),
    );
    if (activeIndex < 0) {
        activeIndex = 0;
    }

    const delta = event.key === "ArrowDown" ? 1 : -1;
    let nextIndex = activeIndex + delta;
    if (nextIndex < 0) {
        nextIndex = items.length - 1;
    } else if (nextIndex >= items.length) {
        nextIndex = 0;
    }

    if (nextIndex !== activeIndex) {
        items[activeIndex]?.classList.remove("rm-menu-item--active");
        const nextItem = items[nextIndex];
        nextItem.classList.add("rm-menu-item--active");
        if (nextItem.dataset.bcpKey) {
            lastActiveKey = nextItem.dataset.bcpKey;
        }
        nextItem.scrollIntoView({ block: "nearest" });
    }
}

function attachPaletteKeydownHandler() {
    if (!portalEl) {
        return;
    }
    if (!paletteKeydownHandler) {
        paletteKeydownHandler = handlePaletteKeydown;
    }
    if (paletteKeydownTarget && paletteKeydownTarget !== portalEl) {
        paletteKeydownTarget.removeEventListener("keydown", paletteKeydownHandler, true);
        paletteKeydownTarget = null;
    }
    if (!paletteKeydownTarget) {
        portalEl.addEventListener("keydown", paletteKeydownHandler, true);
        paletteKeydownTarget = portalEl;
    }
}

function detachPaletteKeydownHandler() {
    if (!paletteKeydownHandler) {
        return;
    }
    if (paletteKeydownTarget) {
        paletteKeydownTarget.removeEventListener("keydown", paletteKeydownHandler, true);
        paletteKeydownTarget = null;
    }
    paletteKeydownHandler = null;
}

function handleMenuClick(event) {
    const item = event.target?.closest?.(".rm-menu-item.bp3-menu-item");
    if (!item) return;
    if (item.dataset?.bcpKey) {
        lastActiveKey = item.dataset.bcpKey;
    }
}

function attachMenuClickHandler(menuEl) {
    if (!menuEl) return;
    if (!menuClickHandler) {
        menuClickHandler = handleMenuClick;
    }
    if (menuClickTarget && menuClickTarget !== menuEl) {
        menuClickTarget.removeEventListener("click", menuClickHandler, true);
        menuClickTarget = null;
    }
    if (!menuClickTarget) {
        menuEl.addEventListener("click", menuClickHandler, true);
        menuClickTarget = menuEl;
    }
}

function detachMenuClickHandler() {
    if (menuClickTarget && menuClickHandler) {
        menuClickTarget.removeEventListener("click", menuClickHandler, true);
    }
    menuClickTarget = null;
    menuClickHandler = null;
}

function applyLastActive(menuEl, itemsMeta) {
    if (!lastActiveKey) return false;
    const match = itemsMeta.find((item) => item.key === lastActiveKey);
    if (!match) return false;
    const currentActive = menuEl.querySelector(".rm-menu-item--active");
    if (currentActive && currentActive !== match.el) {
        currentActive.classList.remove("rm-menu-item--active");
    }
    match.el.classList.add("rm-menu-item--active");
    return true;
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
    try {
        if (menuObserver) {
            menuObserver.disconnect();
        }
        attachMenuObserver(targetPortalEl);
        attachMenuClickHandler(menuEl);
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
        menuVersion += 1;
        keydownCacheMenuEl = menuEl;
        keydownVisibleItems = Array.from(
            menuEl.querySelectorAll(".rm-menu-item.bp3-menu-item"),
        ).filter((item) => item.getClientRects().length > 0);
        keydownCacheVersion = menuVersion;

        if (needsInitialActive) {
            const firstPinned = itemsMeta.find((item) => item.key && pinnedSet.has(item.key));
            if (firstPinned) {
                const currentActive = menuEl.querySelector(".rm-menu-item--active");
                if (currentActive && currentActive !== firstPinned.el) {
                    currentActive.classList.remove("rm-menu-item--active");
                }
                firstPinned.el.classList.add("rm-menu-item--active");
                firstPinned.el.scrollIntoView({ block: "nearest" });
                lastActiveKey = firstPinned.key || null;
                needsInitialActive = false;
            }
        }
        if (!needsInitialActive && lastActiveKey) {
            applyLastActive(menuEl, itemsMeta);
        } else if (!lastActiveKey) {
            const currentActive = menuEl.querySelector(".rm-menu-item--active");
            if (currentActive?.dataset?.bcpKey) {
                lastActiveKey = currentActive.dataset.bcpKey;
            }
        }
        normalizeActiveItem(menuEl);
        scrollActiveItemIntoView(menuEl);
        updateSortControlsState(targetPortalEl);
        if (menuObserver) {
            menuObserver.disconnect();
            menuObserver.observe(menuEl, { childList: true, subtree: true });
        }
    } finally {
        decorateInProgress = false;
        if (decoratePending && !decorateRaf) {
            scheduleDecorate();
        }
    }
}

function scheduleDecorate() {
    decoratePending = true;
    if (decorateRaf || decorateInProgress) {
        return;
    }
    decorateRaf = requestAnimationFrame(() => {
        decorateRaf = null;
        if (!decoratePending || !portalEl) {
            decoratePending = false;
            return;
        }
        decoratePending = false;
        decorateAndApplyPinning(portalEl);
        if (decoratePending) {
            scheduleDecorate();
        }
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
            menuObserver.observe(menuEl, { childList: true, subtree: true });
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
  needsInitialActive = pinnedSet.size > 0;
  menuVersion = 0;
  keydownCacheVersion = -1;
  keydownCacheMenuEl = null;
  keydownVisibleItems = [];
  attachPaletteKeydownHandler();
  attachMenuObserver(nextPortalEl);
  ensureSortControls(nextPortalEl);
  scheduleDecorate();
}

function onPaletteClose() {
    paletteOpen = false;
    detachPaletteKeydownHandler();
    detachMenuClickHandler();
    portalEl = null;
    sessionSortMode = null;
    baseIndexMap = new Map();
    menuObservedEl = null;
    needsInitialActive = false;
    lastActiveKey = null;
    menuVersion = 0;
    keydownCacheVersion = -1;
    keydownCacheMenuEl = null;
    keydownVisibleItems = [];
    decoratePending = false;
    if (menuObserver) {
        menuObserver.disconnect();
        menuObserver = null;
    }
    if (menuFinderObserver) {
        menuFinderObserver.disconnect();
        menuFinderObserver = null;
    }
    if (decorateRaf) {
        cancelAnimationFrame(decorateRaf);
        decorateRaf = null;
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
