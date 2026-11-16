(() => {
    "use strict";

    // 本文件负责页面交互与视图渲染；任务、配置和数据库等状态操作统一通过 PyWebView API 完成。
    const body = document.body;
    const content = document.getElementById("mainContent");
    const viewTitle = document.getElementById("viewTitle");
    const toastRegion = document.getElementById("toastRegion");
    const startupScreen = document.getElementById("startupScreen");

    const viewNames = new Set(["new_task", "monitor", "queue", "history", "logs", "settings", "disclaimer", "about"]);

    let uiTranslations = Object.create(null);
    let translatedUiInitialized = false;
    let aboutLinks = Object.create(null);

    function translateText(key) {
        return uiTranslations[key];
    }

    function formatTranslated(key, values = []) {
        // 替换 {0}、{1} 形式的占位符，统计数据由调用方传入。
        return translateText(key).replace(/\{(\d+)}/g, (match, index) => (
            values[Number(index)] ?? match
        ));
    }

    function applyStaticTranslations() {
        // 根据当前语言包更新 HTML 中标记 data-i18n 的文本及属性。
        document.querySelectorAll("[data-i18n]").forEach((element) => {
            element.textContent = translateText(element.dataset.i18n);
        });
        const attributeKeys = {
            placeholder: "i18nPlaceholder",
            title: "i18nTitle",
        };
        Object.entries(attributeKeys).forEach(([attribute, dataKey]) => {
            document.querySelectorAll(`[data-i18n-${attribute}]`).forEach((element) => {
                element.setAttribute(attribute, translateText(element.dataset[dataKey]));
            });
        });
    }

    function icon(name) {
        return `<svg><use href="#${name}"/></svg>`;
    }

    function showToast(text, type = "success") {
        // 提示消息仅用于短暂反馈，不保存业务状态；业务状态由后端快照负责同步。
        const toast = document.createElement("div");
        toast.className = `toast ${type}`;
        toast.innerHTML = `
            <span class="toast-icon">${icon(type === "warning" ? "info" : "check")}</span>
            <span class="toast-message"></span>
        `;
        toast.querySelector(".toast-message").textContent = text;
        toastRegion.appendChild(toast);
        window.setTimeout(() => {
            toast.classList.add("out");
            window.setTimeout(() => toast.remove(), 200);
        }, 5000);
    }

    function closeSidebar() {
        // 移动端侧栏通过 body 的状态类控制显示和隐藏。
        body.classList.remove("sidebar-open");
    }

    let monitorMode = false;

    function updateViewHeader(name) {
        viewTitle.textContent = translateText(`nav.${name}`);
    }

    function setView(name, options = {}) {
        if (!viewNames.has(name)) return;
        // 监听运行期间锁定其他页面，避免在监听模式下修改配置或创建冲突任务。
        if (monitorMode && name !== "monitor" && !options.force) {
            return;
        }
        const page = document.querySelector(`.view[data-page="${name}"]`);
        if (!page) return;

        document.querySelectorAll(".view").forEach((item) => item.classList.toggle("active", item === page));
        document.querySelectorAll(".nav-item")
                .forEach((item) => item.classList.toggle("active", item.dataset.view === name));
        updateViewHeader(name);
        if (window.location.hash !== `#${name}`) {
            window.history.replaceState(null, "", `#${name}`);
        }
        content.scrollTop = 0;
        if (name === "settings") {
            window.requestAnimationFrame(updateSettingsNavigation);
        }
        closeSidebar();
    }

    // 普通导航和页面内跳转统一调用 setView，确保标题、URL hash 和侧栏状态保持一致。
    document.querySelectorAll("[data-view]").forEach((button) => {
        button.addEventListener("click", () => setView(button.dataset.view));
    });

    document.querySelectorAll("[data-go]").forEach((button) => {
        button.addEventListener("click", () => setView(button.dataset.go));
    });

    document.getElementById("mobileMenu").addEventListener("click", () => body.classList.add("sidebar-open"));
    document.getElementById("sidebarClose").addEventListener("click", closeSidebar);
    document.getElementById("sidebarScrim").addEventListener("click", closeSidebar);

    const monitorToggleButton = document.getElementById("monitorToggleButton");
    const monitorState = document.getElementById("monitorState");
    const monitorEvents = document.getElementById("monitorEvents");
    const monitorQueueEmpty = document.getElementById("monitorQueueEmpty");
    const monitorFileDownloadList = document.getElementById("monitorFileDownloadList");

    function renderMonitorState(active) {
        // 监听页始终显示当前状态；active 仅控制按钮和状态指示，不影响队列展示。
        monitorToggleButton.className = active ? "secondary-button danger-subtle" : "primary-button";
        monitorToggleButton.innerHTML = active
                                        ? `${icon("x")}${translateText("monitor.stop")}`
                                        : `${icon("play")}${translateText("monitor.start")}`;
        monitorState.classList.toggle("inactive", !active);
        monitorState.innerHTML = `<i></i><span>${translateText(active ? "monitor.active" : "monitor.inactive")}</span>`;
    }

    monitorToggleButton.addEventListener("click", () => {
        void runNativeAction(async () => {
            if (monitorMode) await nativeApi.stop_monitor();
            else await nativeApi.start_monitor();
        });
    });

    const disclaimerModal = document.getElementById("disclaimerModal");
    const recordModal = document.getElementById("recordModal");

    document.querySelectorAll("[data-close-modal]").forEach((button) => {
        button.addEventListener("click", () => button.closest("dialog").close());
    });

    document.querySelectorAll("dialog").forEach((dialog) => {
        dialog.addEventListener("cancel", (event) => {
            if (dialog.dataset.blocking === "true") event.preventDefault();
        });
        dialog.addEventListener("click", (event) => {
            if (dialog.dataset.blocking === "true") return;
            if (event.target === dialog) dialog.close();
        });
    });

    // 更新检查的网络请求由后端执行，前端负责显示检查状态、结果和错误反馈。
    const pageCheckUpdate = document.getElementById("pageCheckUpdate");
    const aboutUpdateResult = document.getElementById("aboutUpdateResult");

    function setUpdateResult(message = "", tone = "info") {
        aboutUpdateResult.hidden = !message;
        aboutUpdateResult.dataset.tone = tone;
        aboutUpdateResult.querySelector("span").textContent = message;
    }

    function setUpdateChecking(checking) {
        pageCheckUpdate.disabled = checking;
        pageCheckUpdate.classList.toggle("is-loading", checking);
        pageCheckUpdate.innerHTML = `${icon("refresh")}${translateText("update.check")}`;
    }

    // 创建任务区域提交原始输入，作品链接提取和下载规则均由后端处理。
    const urlInput = document.getElementById("urlInput");
    const indexInput = document.getElementById("indexInput");
    const createTask = document.getElementById("createTask");

    function updateCreateButton() {
        const hasContent = Boolean(urlInput.value.trim());
        createTask.disabled = !hasContent;
        return hasContent;
    }

    function getImageIndex() {
        const values = indexInput.value
                                 .trim()
                                 .split(/[\s,，]+/)
                                 .filter((value) => /^\d+$/.test(value))
                                 .map((value) => Number.parseInt(value, 10));
        return values.length ? values : null;
    }

    function insertTextAtCursor(input, text) {
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? start;
        input.value = `${input.value.slice(0, start)}${text}${input.value.slice(end)}`;
        const cursor = start + text.length;
        input.setSelectionRange(cursor, cursor);
        updateCreateButton();
    }

    urlInput.addEventListener("input", updateCreateButton);

    urlInput.addEventListener("keydown", (event) => {
        if (!(event.key?.toLowerCase() === "v" && (event.ctrlKey || event.metaKey))) return;
        const previousValue = urlInput.value;
        window.setTimeout(() => {
            if (urlInput.value !== previousValue) return;
            void runNativeAction(async () => {
                const content = await nativeApi.paste_content();
                if (!content) return;
                insertTextAtCursor(urlInput, content);
                urlInput.focus();
            });
        });
    });

    document.getElementById("clearInput").addEventListener("click", () => {
        urlInput.value = "";
        indexInput.value = "";
        updateCreateButton();
        urlInput.focus();
    });

    document.getElementById("pasteButton").addEventListener("click", () => {
        void runNativeAction(async () => {
            const content = await nativeApi.paste_content();
            if (content) insertTextAtCursor(urlInput, content);
            urlInput.focus();
        });
    });

    createTask.addEventListener("click", () => {
        void runNativeAction(async () => {
            const created = await nativeApi.create_tasks(urlInput.value, getImageIndex());
            if (!created.length) throw new Error(translateText("toast.no_supported_link"));
            urlInput.value = "";
            indexInput.value = "";
            updateCreateButton();
        });
    });
    document.getElementById("pasteAndProcess").addEventListener("click", () => {
        void runNativeAction(async () => {
            const content = await nativeApi.paste_content();
            urlInput.value = content;
            updateCreateButton();
            const created = await nativeApi.create_tasks(content, getImageIndex());
            if (!created.length) throw new Error(translateText("toast.no_supported_link"));
            urlInput.value = "";
            indexInput.value = "";
            updateCreateButton();
        });
    });

    // 任务队列和文件下载区使用独立的滚动容器，避免条目增加时改变页面整体高度。
    const queueList = document.getElementById("queueList");
    const queueEmpty = document.getElementById("queueEmpty");
    const fileDownloadList = document.getElementById("fileDownloadList");
    let currentQueueFilter = "all";

    const listScrollStates = new WeakMap();

    function isNearTop(target, threshold = 2) {
        return target.scrollTop <= threshold;
    }

    function followsTop(target) {
        let state = listScrollStates.get(target);
        if (state) return state.followTop;
        state = {followTop: true};
        target.addEventListener("scroll", () => {
            state.followTop = isNearTop(target);
        });
        listScrollStates.set(target, state);
        return state.followTop;
    }

    function preserveTopScroll(target, shouldStickToTop, update) {
        const state = listScrollStates.get(target);
        const scrollHeight = target.scrollHeight;
        const scrollTop = target.scrollTop;
        update();
        if (shouldStickToTop || target.scrollHeight <= target.clientHeight + 2) {
            target.scrollTop = 0;
            state.followTop = true;
            return;
        }
        target.scrollTop = Math.max(0, scrollTop + target.scrollHeight - scrollHeight);
        state.followTop = isNearTop(target);
    }

    function markListItemEntering(item) {
        item.classList.add("is-entering");
        item.addEventListener("animationend", () => item.classList.remove("is-entering"), {once: true});
    }

    function syncKeyedList(target, items, keyForItem, createItem, updateItem, createEmptyItem = null) {
        const existing = new Map(
            [...target.children]
                .filter((child) => child.dataset.key)
                .map((child) => [child.dataset.key, child]),
        );
        const children = items.map((item) => {
            const key = keyForItem(item);
            const current = existing.get(key);
            if (current) {
                existing.delete(key);
                updateItem(current, item);
                return current;
            }
            const created = createItem(item);
            created.dataset.key = key;
            markListItemEntering(created);
            return created;
        });
        existing.forEach((child) => child.remove());
        if (children.length) {
            target.replaceChildren(...children);
        } else if (createEmptyItem) {
            target.replaceChildren(createEmptyItem());
        } else {
            target.replaceChildren();
        }
    }

    function matchesQueueFilter(state, filter = currentQueueFilter) {
        // 筛选仅修改当前视图的 hidden 状态，不会从后端任务集合中删除任务。
        if (filter === "all") return true;
        return state === filter;
    }

    function refreshQueue() {
        // 根据后端快照生成的 DOM 统计各状态数量，并更新筛选结果为空时的提示。
        const items = [...queueList.querySelectorAll(".queue-item")];
        const counts = items.reduce((result, item) => {
            result[item.dataset.state] += 1;
            item.hidden = !matchesQueueFilter(item.dataset.state);
            return result;
        }, {
                                        processing: 0,
                                        pending: 0,
                                        success: 0,
                                        failed: 0,
                                        skipped: 0,
                                    });
        const processing = counts.processing;
        const pending = counts.pending;
        const success = counts.success;
        const failed = counts.failed;
        const skipped = counts.skipped;
        const visible = items.filter((item) => !item.hidden).length;

        document.getElementById("pendingMetric").innerHTML = `${pending} <small>${translateText("unit.item")}</small>`;
        document.getElementById("successMetric").innerHTML = `${success} <small>${translateText("unit.item")}</small>`;
        document.getElementById("failedMetric").innerHTML = `${failed} <small>${translateText("unit.item")}</small>`;
        document.getElementById("skippedMetric").innerHTML = `${skipped} <small>${translateText("unit.item")}</small>`;
        document.getElementById("queueBadge").textContent = String(processing + pending);
        queueEmpty.querySelector("strong").textContent = translateText(
            currentQueueFilter === "all" ? "task.queue_empty" : "queue.current_filter_empty",
        );
        queueList.hidden = visible === 0;
        queueEmpty.hidden = visible !== 0;
    }

    document.getElementById("queueFilters").addEventListener("click", (event) => {
        const button = event.target.closest("[data-filter]");
        if (!button) return;
        currentQueueFilter = button.dataset.filter;
        document.querySelectorAll("#queueFilters button")
                .forEach((item) => item.classList.toggle("active", item === button));
        refreshQueue();
    });

    document.getElementById("copyTaskLinks").addEventListener("click", () => {
        void runNativeAction(async () => {
            const copied = await nativeApi.copy_task_links(currentQueueFilter);
            if (copied === 0) {
                showToast(translateText("toast.no_links_to_copy"), "warning");
                return;
            }
            showToast(formatTranslated("toast.links_copied", [copied]));
        });
    });

    let currentMonitorFilter = "all";

    function refreshMonitorQueue() {
        // 监听页仅展示 source=monitor 的任务，状态筛选规则与主队列保持一致。
        const items = [...monitorEvents.querySelectorAll(".queue-item")];
        items.forEach((item) => {
            item.hidden = !matchesQueueFilter(item.dataset.state, currentMonitorFilter);
        });
        const visible = items.filter((item) => !item.hidden).length;
        monitorQueueEmpty.querySelector("strong").textContent = translateText(
            currentMonitorFilter === "all" ? "monitor.queue_empty" : "queue.current_filter_empty",
        );
        monitorEvents.hidden = visible === 0;
        monitorQueueEmpty.hidden = visible !== 0;
    }

    document.getElementById("monitorQueueFilters").addEventListener("click", (event) => {
        const button = event.target.closest("[data-filter]");
        if (!button) return;
        currentMonitorFilter = button.dataset.filter;
        document.querySelectorAll("#monitorQueueFilters button")
                .forEach((item) => item.classList.toggle("active", item === button));
        refreshMonitorQueue();
    });

    // 下载记录仅包含作品 ID；搜索、总数和分页信息均由数据库查询结果决定。
    const historySearch = document.getElementById("historySearch");
    const historyBody = document.getElementById("historyBody");
    const historyEmpty = document.getElementById("historyEmpty");
    const selectAllRecords = document.getElementById("selectAllRecords");
    const invertRecordSelection = document.getElementById("invertRecordSelection");
    const deleteSelectedRecords = document.getElementById("deleteSelectedRecords");
    const selectedRecordCount = document.getElementById("selectedRecordCount");
    const historyPrev = document.getElementById("historyPrev");
    const historyNext = document.getElementById("historyNext");
    const historyPageLabel = document.getElementById("historyPage");
    const historyView = document.querySelector(".history-view");
    let historyPageSize = 0;
    let historyPage = 1;
    let historyPageCount = 0;
    let historyTotal = 0;
    let historyQuery = "";
    let historyEnabled = true;
    let historyRequestId = 0;
    let historySearchTimer = null;
    let lastHistoryRevision = null;

    function recordRows() {
        return [...historyBody.querySelectorAll(".history-record")];
    }

    function selectedHistoryIds() {
        return recordRows()
            .filter((row) => row.querySelector(".record-select").checked)
            .map((row) => row.querySelector("code").textContent);
    }

    function updateRecordSummary() {
        const rows = recordRows();
        const start = historyTotal ? ((historyPage - 1) * historyPageSize) + 1 : 0;
        const end = historyTotal ? start + rows.length - 1 : 0;
        document.getElementById("recordRange").textContent = !historyEnabled
                                                             ? ""
                                                             : historyTotal
                                                               ? formatTranslated(
                    "history.range",
                    [start, end, historyTotal,
                     historyQuery ? translateText(
                         "history.search_results") : ""]
                )
                                                               : historyQuery ? translateText("history.no_match") :
                                                                 translateText("history.empty");
        historyPageLabel.textContent = historyPageCount ? `${historyPage} / ${historyPageCount}` : "0 / 0";
        historyPrev.disabled = !historyEnabled || !historyPageCount || historyPage <= 1;
        historyNext.disabled = !historyEnabled || !historyPageCount || historyPage >= historyPageCount;
    }

    function updateRecordSelection() {
        // 选择状态仅属于当前页，不跨页保存；删除选中记录必须经过确认对话框。
        const rows = recordRows();
        const selectedRows = rows.filter((row) => row.querySelector(".record-select").checked);

        rows.forEach((row) => {
            const selected = row.querySelector(".record-select").checked;
            row.classList.toggle("selected", selected);
        });
        selectAllRecords.checked = rows.length > 0 && selectedRows.length === rows.length;
        selectAllRecords.indeterminate = selectedRows.length > 0 && selectedRows.length < rows.length;
        selectAllRecords.disabled = !historyEnabled || rows.length === 0;
        invertRecordSelection.disabled = !historyEnabled || rows.length === 0;
        selectedRecordCount.textContent = formatTranslated("history.selected", [selectedRows.length]);
        deleteSelectedRecords.disabled = !historyEnabled || selectedRows.length === 0;
        updateRecordSummary();
    }

    function setHistoryEnabled(enabled) {
        // 下载记录关闭后，整个记录视图进入只读禁用状态，禁止继续调用数据库接口。
        historyEnabled = Boolean(enabled);
        historyView.classList.toggle("is-disabled", !historyEnabled);
        historySearch.disabled = !historyEnabled;
        if (!historyEnabled) {
            historyRequestId += 1;
            historyBody.replaceChildren();
            historyBody.hidden = true;
            historyEmpty.hidden = false;
            historyEmpty.querySelector("strong").textContent = translateText("history.disabled");
            historyTotal = 0;
            historyPage = 0;
            historyPageCount = 0;
            historyQuery = "";
            historySearch.value = "";
        }
        updateRecordSelection();
    }

    function renderNativeHistoryPage(result) {
        // 后端每次最多返回 100 个 ID，前端负责生成紧凑且可整体选中的记录行。
        setHistoryEnabled(result.enabled !== false);
        if (!historyEnabled) return;
        historyTotal = Number(result.total);
        historyPage = Number(result.page);
        historyPageSize = Number(result.page_size);
        historyPageCount = Number(result.page_count);
        historyQuery = String(result.query);
        historyBody.replaceChildren();
        result.items.forEach((id) => {
            const row = document.createElement("li");
            row.className = "history-record";
            row.tabIndex = 0;
            const label = document.createElement("span");
            label.className = "record-checkbox";
            const checkbox = document.createElement("input");
            checkbox.className = "record-select";
            checkbox.type = "checkbox";
            checkbox.tabIndex = -1;
            const mark = document.createElement("span");
            mark.className = "checkmark";
            mark.innerHTML = icon("check");
            label.append(checkbox, mark);
            const code = document.createElement("code");
            code.textContent = id;
            row.append(label, code);
            historyBody.append(row);
        });
        const hasRows = recordRows().length > 0;
        historyEmpty.hidden = hasRows;
        historyEmpty.querySelector("strong").textContent = translateText(
            historyQuery ? "history.no_match" : "history.empty");
        historyBody.hidden = !hasRows;
        updateRecordSelection();
    }

    async function requestHistoryPage(page = 1) {
        // 通过 requestId 丢弃过期的搜索请求，防止慢响应覆盖较新的查询结果。
        if (!historyEnabled) return;
        const requestId = ++historyRequestId;
        const query = historySearch.value.trim();
        try {
            const result = await nativeApi.get_history_page(query, page);
            if (requestId !== historyRequestId) return;
            renderNativeHistoryPage(result);
        } catch (error) {
            if (requestId === historyRequestId) showToast(
                translateText("history.read_failed"), "warning");
        }
    }

    historySearch.addEventListener("input", () => {
        window.clearTimeout(historySearchTimer);
        historySearchTimer = window.setTimeout(() => {
            void requestHistoryPage(1);
        }, 250);
    });

    historyPrev.addEventListener("click", () => {
        if (historyPage <= 1) return;
        void requestHistoryPage(historyPage - 1);
    });

    historyNext.addEventListener("click", () => {
        if (historyPage >= historyPageCount) return;
        void requestHistoryPage(historyPage + 1);
    });

    function toggleHistoryRow(row) {
        if (!historyEnabled || !row) return;
        const checkbox = row.querySelector(".record-select");
        checkbox.checked = !checkbox.checked;
        updateRecordSelection();
    }

    historyBody.addEventListener("click", (event) => {
        const row = event.target.closest(".history-record");
        if (!row) return;
        event.preventDefault();
        toggleHistoryRow(row);
    });

    historyBody.addEventListener("keydown", (event) => {
        if (event.key !== " " && event.key !== "Enter") return;
        const row = event.target.closest(".history-record");
        if (!row) return;
        event.preventDefault();
        toggleHistoryRow(row);
    });

    selectAllRecords.addEventListener("change", () => {
        recordRows().forEach((row) => {
            row.querySelector(".record-select").checked = selectAllRecords.checked;
        });
        updateRecordSelection();
    });

    invertRecordSelection.addEventListener("click", () => {
        recordRows().forEach((row) => {
            const checkbox = row.querySelector(".record-select");
            checkbox.checked = !checkbox.checked;
        });
        updateRecordSelection();
    });

    deleteSelectedRecords.addEventListener("click", () => {
        const ids = selectedHistoryIds();
        if (!historyEnabled || ids.length === 0) return;
        document.getElementById("recordDeletePrompt").textContent = formatTranslated(
            "modal.delete_history_confirm", [ids.length]);
        recordModal.showModal();
    });

    const logConsole = document.getElementById("logConsole");

    // 左侧导航独立不滚，右侧设置面板滚动并联动导航高亮。
    const settingsPanel = document.getElementById("settingsPanel");
    const settingsNavButtons = [...document.querySelectorAll(".settings-nav button")];
    const settingsGroups = settingsNavButtons
        .map((button) => document.getElementById(button.dataset.setting))
        .filter(Boolean);
    let settingsScrollTarget = null;

    function setActiveSettingsGroup(groupId) {
        settingsNavButtons.forEach((button) => {
            button.classList.toggle("active", button.dataset.setting === groupId);
        });
    }

    function updateSettingsNavigation() {
        if (!settingsPanel || settingsGroups.length === 0 || settingsPanel.clientHeight === 0) return;

        const panelTop = settingsPanel.getBoundingClientRect().top;
        const atBottom = settingsPanel.scrollTop
            >= settingsPanel.scrollHeight - settingsPanel.clientHeight - 1;

        if (settingsScrollTarget) {
            const targetTop = settingsScrollTarget.getBoundingClientRect().top - panelTop;
            const targetIsLast = settingsScrollTarget === settingsGroups[settingsGroups.length - 1];
            if (Math.abs(targetTop) <= 1 || (targetIsLast && atBottom)) {
                settingsScrollTarget = null;
            } else {
                return;
            }
        }

        let activeGroup = settingsGroups[0];

        if (atBottom) {
            activeGroup = settingsGroups[settingsGroups.length - 1];
        } else {
            settingsGroups.forEach((group) => {
                if (group.getBoundingClientRect().top <= panelTop + 24) {
                    activeGroup = group;
                }
            });
        }
        setActiveSettingsGroup(activeGroup.id);
    }

    settingsNavButtons.forEach((button) => {
        button.addEventListener("click", () => {
            const target = document.getElementById(button.dataset.setting);
            if (!target) return;
            settingsScrollTarget = target;
            setActiveSettingsGroup(button.dataset.setting);
            const top = target.getBoundingClientRect().top - settingsPanel.getBoundingClientRect().top + settingsPanel.scrollTop;
            settingsPanel.scrollTo({top, behavior: "smooth"});
        });
    });
    settingsPanel?.addEventListener("wheel", () => {
        settingsScrollTarget = null;
    }, {passive: true});
    settingsPanel?.addEventListener("touchstart", () => {
        settingsScrollTarget = null;
    }, {passive: true});
    settingsPanel?.addEventListener("scroll", updateSettingsNavigation, {passive: true});
    window.addEventListener("resize", updateSettingsNavigation);

    // 文件名称格式使用可编辑模板：预设字段以 %字段% 占位符存储，编辑器中渲染为可辨识的 chip，
    // 用户可自由输入分隔符和固定文字；输入内容实时同步预览并自动保存。
    let NAME_FORMAT_FIELDS = [];
    const nameFormatEditor = document.getElementById("nameFormatEditor");
    const nameFormatFields = document.getElementById("nameFormatFields");
    const nameFormatPreview = document.getElementById("nameFormatPreview");

    // 预览示例值：为每个字段提供一组贴近真实数据的展示值。
    const NAME_PREVIEW_VALUES = {
        "收藏数量": "128",
        "评论数量": "32",
        "分享数量": "15",
        "点赞数量": "1024",
        "作品标签": "美食",
        "作品ID": "5078219042",
        "作品标题": "城市美食探店",
        "作品描述": "今天分享一家宝藏小店",
        "作品类型": "图文",
        "发布时间": "2024-08-18 14\u02D030\u02D000",
        "最后更新时间": "2024-08-18 15\u02D000\u02D000",
        "作者昵称": "旅行日记",
        "作者ID": "5f0a1b2c3d4e",
    };

    function escapeRegExp(value) {
        return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    // 将编辑器节点序列化为 %字段% 模板字符串：文本节点取原文，chip 还原为 %字段%。
    function nameFormatValue() {
        let result = "";
        nameFormatEditor.childNodes.forEach((node) => {
            if (node.nodeType === Node.TEXT_NODE) {
                result += node.textContent;
            } else if (node.nodeType === Node.ELEMENT_NODE) {
                result += node.dataset.nameField
                    ? `%${node.dataset.nameField}%`
                    : node.textContent;
            }
        });
        return result;
    }

    function renderNameFormatPreview() {
        // 将模板中的 %字段% 占位符替换为示例值，展示真实文件名效果。
        let preview = nameFormatValue();
        NAME_FORMAT_FIELDS.forEach((field) => {
            preview = preview.replace(
                new RegExp(`%${escapeRegExp(field)}%`, "g"),
                NAME_PREVIEW_VALUES[field] ?? "",
            );
        });
        nameFormatPreview.textContent = preview || "-";
    }

    function createNameFormatChip(field) {
        // 字段选择面板中的可点击项，点击后插入到编辑器光标处。
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "name-format-field-chip";
        chip.dataset.nameField = field;
        chip.textContent = translateText(field);
        chip.title = translateText("settings.insert_field");
        return chip;
    }

    function renderNameFormatFields() {
        nameFormatFields.replaceChildren(
            ...NAME_FORMAT_FIELDS.map((field) => createNameFormatChip(field)),
        );
    }

    // 编辑器内部的 chip 节点：contenteditable=false 的原子元素。
    function buildNameFormatChipNode(field) {
        const chipNode = document.createElement("span");
        chipNode.className = "name-format-token";
        chipNode.contentEditable = "false";
        chipNode.dataset.nameField = field;
        chipNode.textContent = translateText(field);
        return chipNode;
    }

    function insertNameFormatField(field) {
        // 将字段插入到编辑器当前光标位置，并触发预览与自动保存。
        nameFormatEditor.focus();
        const selection = window.getSelection();
        let range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        if (!range || !nameFormatEditor.contains(range.commonAncestorContainer)) {
            range = document.createRange();
            range.selectNodeContents(nameFormatEditor);
            range.collapse(false);
        }
        range.deleteContents();
        const chipNode = buildNameFormatChipNode(field);
        range.insertNode(chipNode);
        range.setStartAfter(chipNode);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        renderNameFormatPreview();
        scheduleSettingsSave();
    }

    // 将 %字段% 模板还原为编辑器内容（chip + 裸文本节点，字面文本与 chip 共用 line-height，baseline 对齐）。
    function applyNameFormat(value) {
        const template = String(value || "");
        nameFormatEditor.replaceChildren();
        const pattern = /%([^%]+)%/g;
        let cursor = 0;
        let match;
        while ((match = pattern.exec(template)) !== null) {
            const literal = template.slice(cursor, match.index);
            if (literal) nameFormatEditor.appendChild(document.createTextNode(literal));
            const field = match[1];
            if (NAME_FORMAT_FIELDS.includes(field)) {
                nameFormatEditor.appendChild(buildNameFormatChipNode(field));
            } else {
                nameFormatEditor.appendChild(document.createTextNode(match[0]));
            }
            cursor = pattern.lastIndex;
        }
        const tail = template.slice(cursor);
        if (tail) nameFormatEditor.appendChild(document.createTextNode(tail));
        renderNameFormatPreview();
    }

    nameFormatFields.addEventListener("click", (event) => {
        const chip = event.target.closest(".name-format-field-chip");
        if (!chip) return;
        insertNameFormatField(chip.dataset.nameField);
    });

    nameFormatEditor.addEventListener("input", () => {
        renderNameFormatPreview();
        scheduleSettingsSave();
    });

    // 判断光标（折叠）或选区（展开）是否命中 chip，命中则原子删除整块，防止浏览器拆解 chip。
    nameFormatEditor.addEventListener("beforeinput", (event) => {
        const delTypes = ["deleteContentBackward", "deleteContentForward", "deleteByCut", "deleteByDrag"];
        if (!delTypes.includes(event.inputType)) return;
        const selection = window.getSelection();
        if (!selection?.rangeCount) return;
        const range = selection.getRangeAt(0);
        if (!nameFormatEditor.contains(range.commonAncestorContainer)) return;

        const chips = [...nameFormatEditor.querySelectorAll(".name-format-token")];

        // 展开选区：删除任何与选区相交的 chip。
        if (!range.collapsed) {
            const hit = chips.filter((chip) => range.intersectsNode(chip));
            if (hit.length === 0) return;
            event.preventDefault();
            hit.forEach((chip) => chip.remove());
            renderNameFormatPreview();
            scheduleSettingsSave();
            return;
        }

        // 折叠光标：沿 DOM 向上找紧邻的 chip（处理光标落在文本节点或 span 内的情况）。
        const backward = event.inputType === "deleteContentBackward";
        const node = backward ? range.startContainer : range.endContainer;
        const offset = backward ? range.startOffset : range.endOffset;
        if (node.nodeType === Node.TEXT_NODE) {
            if (backward ? offset > 0 : offset < node.textContent.length) return;
        }
        let cursor = node;
        while (cursor && cursor !== nameFormatEditor) {
            const sibling = backward ? cursor.previousSibling : cursor.nextSibling;
            if (sibling) {
                if (sibling.nodeType === Node.ELEMENT_NODE && sibling.classList.contains("name-format-token")) {
                    event.preventDefault();
                    sibling.remove();
                    renderNameFormatPreview();
                    scheduleSettingsSave();
                    return;
                }
                if (sibling.nodeType === Node.TEXT_NODE && sibling.textContent.length > 0) return;
            }
            cursor = cursor.parentNode;
        }
    });

    function initializeTranslatedUi() {
        refreshQueue();
        refreshMonitorQueue();
        updateRecordSelection();
        renderMonitorState(monitorMode);
        if (!translatedUiInitialized) {
            const initialView = window.location.hash.slice(1);
            setView(viewNames.has(initialView) ? initialView : "new_task");
            translatedUiInitialized = true;
        }
    }

    // PyWebView 负责所有数据变更，DOM 仅渲染快照；以下变量用于控制轮询和请求去重。
    let nativeApi = null;
    let bridgeRefreshBusy = false;
    let settingsLoaded = false;
    let lastLogKey = null;
    let stateRefreshTimer = null;

    const statusLabels = {
        processing: "queue.processing",
        pending: "queue.pending",
        success: "queue.success",
        failed: "queue.failed",
        skipped: "queue.skipped",
        cancelled: "queue.cancelled",
    };

    function statusClass(state) {
        // 将后端状态映射为 CSS 状态类，显示文案由 statusLabels 映射到翻译键。
        if (state === "success") return "completed";
        if (state === "failed") return "failed";
        if (state === "skipped") return "skipped";
        if (state === "processing") return "downloading";
        return "waiting";
    }

    function formatBytes(value) {
        // 文件进度固定使用 MB；总大小未知时由调用方显示“未知大小”。
        if (!Number.isFinite(value) || value <= 0) return "0.00MB";
        return `${(value / (1024 ** 2)).toFixed(2)} MB`;
    }

    function fillNativeQueueItem(item, task) {
        // 根据后端任务快照创建主队列条目；仅 pending 任务显示取消按钮。
        item.replaceChildren();
        item.dataset.state = task.state;
        item.dataset.taskId = task.task_id;

        const symbol = document.createElement("span");
        symbol.className = "queue-symbol";
        symbol.innerHTML = icon("link");
        const detail = document.createElement("div");
        detail.className = "queue-detail";
        const link = document.createElement("code");
        link.textContent = task.display_text;
        link.title = task.url || task.display_text;
        const stateLine = document.createElement("div");
        stateLine.className = "queue-state-line";
        const state = document.createElement("span");
        state.className = `status-text ${statusClass(task.state)}`;
        state.textContent = translateText(statusLabels[task.state]);
        stateLine.append(state);
        detail.append(link, stateLine);
        item.append(symbol, detail);
        if (task.state === "pending") {
            const actions = document.createElement("div");
            actions.className = "queue-actions";
            const cancel = document.createElement("button");
            cancel.className = "icon-button danger-icon";
            cancel.type = "button";
            cancel.dataset.action = "cancel";
            cancel.innerHTML = icon("x");
            actions.append(cancel);
            item.append(actions);
        }
    }

    function updateNativeQueueItem(item, task) {
        const renderKey = JSON.stringify([
                                             task.task_id,
                                             task.display_text,
                                             task.url,
                                             task.state,
                                         ]);
        if (item.dataset.renderKey === renderKey) return;
        item.dataset.renderKey = renderKey;
        fillNativeQueueItem(item, task);
    }

    function createNativeQueueItem(task) {
        const item = document.createElement("article");
        item.className = "queue-item";
        updateNativeQueueItem(item, task);
        return item;
    }

    function updateNativeCompactTask(item, task) {
        const renderKey = JSON.stringify([
                                             task.task_id,
                                             task.display_text,
                                             task.url,
                                             task.state,
                                         ]);
        if (item.dataset.renderKey === renderKey) return;
        item.dataset.renderKey = renderKey;
        item.replaceChildren();
        // 首页显示紧凑的任务摘要，完整链接和状态在处理队列页查看。
        const symbol = document.createElement("span");
        symbol.className = "queue-symbol";
        symbol.innerHTML = icon("link");
        const primary = document.createElement("div");
        primary.className = "task-primary";
        const link = document.createElement("code");
        link.textContent = task.display_text;
        link.title = task.url || task.display_text;
        primary.append(link);
        const state = document.createElement("span");
        state.className = `status-text ${statusClass(task.state)}`;
        if (task.state === "success") state.innerHTML = icon("check");
        else state.append(document.createElement("i"));
        state.append(document.createTextNode(translateText(statusLabels[task.state])));
        item.append(symbol, primary, state);
    }

    function createNativeCompactTask(task) {
        const item = document.createElement("article");
        item.className = "compact-task";
        updateNativeCompactTask(item, task);
        return item;
    }

    function createNativeFileEmpty() {
        const empty = document.createElement("div");
        empty.className = "file-download-empty";
        empty.innerHTML = `${icon("download")}<span>${translateText("download.empty")}</span>`;
        return empty;
    }

    function updateNativeFileRow(row, file) {
        const renderKey = JSON.stringify([
                                             file.file_id,
                                             file.filename,
                                             file.completed_bytes,
                                             file.total_bytes,
                                             file.state,
                                         ]);
        if (row.dataset.renderKey === renderKey) return;
        row.dataset.renderKey = renderKey;
        row.replaceChildren();
        const head = document.createElement("div");
        head.className = "file-download-head";
        const name = document.createElement("strong");
        name.textContent = file.filename;
        name.title = file.filename;
        const meta = document.createElement("div");
        meta.className = "file-download-meta";
        const size = document.createElement("span");
        const completed = formatBytes(Number(file.completed_bytes));
        const total = file.total_bytes ? formatBytes(Number(file.total_bytes)) :
                      translateText("download.unknown_size");
        const percent = file.total_bytes ? Math.min(100, (file.completed_bytes / file.total_bytes) * 100) : 0;
        const progress = document.createElement("span");
        size.textContent = file.total_bytes ? `${completed}/${total}` : completed;
        progress.textContent = file.total_bytes ? `${Math.round(percent)}%` : "";
        meta.append(size, progress);
        head.append(name, meta);
        const line = document.createElement("div");
        line.className = `progress-line file ${file.state === "completed" ? "completed" : ""}`;
        const fill = document.createElement("i");
        fill.style.width = `${percent}%`;
        line.append(fill);
        row.append(head, line);
    }

    function createNativeFileRow(file) {
        const row = document.createElement("article");
        row.className = "file-download-row";
        updateNativeFileRow(row, file);
        return row;
    }

    function renderNativeFiles(target, files) {
        // 每个文件独立显示名称、已完成大小、总大小和实时进度条；列表容器负责滚动。
        const shouldStickToTop = followsTop(target);
        preserveTopScroll(target, shouldStickToTop, () => {
            syncKeyedList(
                target,
                [...files].reverse(),
                (file) => file.file_id,
                createNativeFileRow,
                updateNativeFileRow,
                createNativeFileEmpty,
            );
        });
        const count = target.closest(".file-download-section")?.querySelector(".section-heading span");
        if (count) count.textContent = `${files.length} ${translateText("unit.file")}`;
    }

    function renderNativeTaskLists(tasks, files) {
        // 使用一次状态快照同时刷新主队列、监听队列及两个文件下载区域。
        const visibleTasks = tasks.filter((task) => task.state !== "cancelled").reverse();
        const queueShouldStickToTop = followsTop(queueList);
        const monitorShouldStickToTop = followsTop(monitorEvents);
        preserveTopScroll(queueList, queueShouldStickToTop, () => {
            syncKeyedList(
                queueList,
                visibleTasks,
                (task) => task.task_id,
                createNativeQueueItem,
                updateNativeQueueItem,
            );
            refreshQueue();
        });
        const dashboardTasks = document.getElementById("dashboardTasks");
        const dashboardShouldStickToTop = followsTop(dashboardTasks);
        preserveTopScroll(dashboardTasks, dashboardShouldStickToTop, () => {
            if (visibleTasks.length) {
                syncKeyedList(
                    dashboardTasks,
                    visibleTasks,
                    (task) => task.task_id,
                    createNativeCompactTask,
                    updateNativeCompactTask,
                );
                return;
            }
            const empty = document.createElement("div");
            empty.className = "dashboard-empty";
            empty.textContent = translateText("task.queue_empty");
            dashboardTasks.replaceChildren(empty);
        });
        document.getElementById("dashboardTaskCount").textContent = `${visibleTasks.length} ${translateText(
            "unit.item")}`;
        const monitorTasks = visibleTasks.filter((task) => task.source === "monitor");
        preserveTopScroll(monitorEvents, monitorShouldStickToTop, () => {
            syncKeyedList(
                monitorEvents,
                monitorTasks,
                (task) => task.task_id,
                createNativeQueueItem,
                updateNativeQueueItem,
            );
            refreshMonitorQueue();
        });
        const monitorIds = new Set(monitorTasks.map((task) => task.task_id));
        renderNativeFiles(fileDownloadList, files);
        renderNativeFiles(monitorFileDownloadList, files.filter((file) => monitorIds.has(file.task_id)));
    }

    function renderNativeLogs(logs) {
        // 通过 JSON 快照去重，避免每 500 ms 轮询都重建未发生变化的日志节点。
        const key = JSON.stringify(logs);
        if (key === lastLogKey) return;
        lastLogKey = key;
        logConsole.replaceChildren();
        logs.forEach((entry) => {
            const line = document.createElement("div");
            line.dataset.level = entry.level;
            const time = document.createElement("time");
            time.textContent = entry.time;
            const level = document.createElement("span");
            level.className = `log-level ${entry.level}`;
            level.textContent = entry.level.toUpperCase();
            const message = document.createElement("p");
            message.textContent = entry.message;
            line.append(time, level, message);
            logConsole.append(line);
        });
    }

    function applyNativeSettings(settings) {
        // 首次接收后端配置时填充表单；用户编辑后不再被轮询覆盖。
        if (settingsLoaded) return;
        document.getElementById("settingsWorkPath").value = settings.work_path;
        document.getElementById("settingsFolderName").value = settings.folder_name;
        applyNameFormat(settings.name_format);
        document.getElementById("settingsImageDownload").checked = Boolean(settings.image_download);
        document.getElementById("settingsVideoDownload").checked = Boolean(settings.video_download);
        document.getElementById("settingsLiveDownload").checked = Boolean(settings.live_download);
        document.getElementById("settingsVideoCoverDownload").checked = Boolean(settings.video_cover_download);
        document.getElementById("settingsImageFormat").value = settings.image_format.toLowerCase();
        document.getElementById("settingsVideoPreference").value = settings.video_preference;
        document.getElementById("settingsNoteFormat").value = settings.note_format;
        document.getElementById("settingsFolderMode").checked = Boolean(settings.folder_mode);
        document.getElementById("settingsAuthorArchive").checked = Boolean(settings.author_archive);
        document.getElementById("settingsDownloadRecord").checked = Boolean(settings.download_record);
        document.getElementById("settingsRecordData").checked = Boolean(settings.record_data);
        document.getElementById("settingsWriteMtime").checked = Boolean(settings.write_mtime);
        document.getElementById("settingsCookie").value = settings.cookie || "";
        document.getElementById("settingsImpersonate").value = settings.impersonate || "";
        document.getElementById("settingsProxy").value = settings.proxy || "";
        document.getElementById("settingsTimeout").value = String(settings.timeout);
        document.getElementById("settingsMaxRetry").value = String(settings.max_retry);
        document.getElementById("settingsAvgDelay").value = String(settings.avg_delay);
        document.getElementById("settingsChunkSize").value = String(settings.chunk);
        document.getElementById("settingsLanguage").value = settings.language;
        document.getElementById("settingsScriptServer").checked = Boolean(settings.script_server);
        document.getElementById("settingsProxyDownload").checked = Boolean(settings.proxy_download);
        settingsLoaded = true;
        bindSettingsAutoSave();
    }

    async function refreshUiTranslations() {
        // 保存语言设置后重新获取完整文案，并重建依赖翻译的动态控件。
        const payload = await nativeApi.get_translations();
        uiTranslations = Object.assign(Object.create(null), payload.messages);
        NAME_FORMAT_FIELDS = payload.name_fields;
        document.documentElement.lang = payload.language === "en_US" ? "en" : "zh-CN";
        applyStaticTranslations();
        const nameFormat = nameFormatValue();
        applyNameFormat(nameFormat);
        renderNameFormatFields();
        const activeView = document.querySelector(".view.active")?.dataset.page;
        if (viewNames.has(activeView)) {
            updateViewHeader(activeView);
        }
        initializeTranslatedUi();
    }

    function collectNativeSettings() {
        // 名称格式以 %字段% 模板字符串提交，后端还原英文显示名并校验占位符。
        const chunkSize = Math.max(
            1, Number.parseInt(document.getElementById("settingsChunkSize").value, 10) || 2097152);
        return {
            work_path: document.getElementById("settingsWorkPath").value.trim(),
            folder_name: document.getElementById("settingsFolderName").value.trim() || "Download",
            name_format: nameFormatValue(),
            image_download: document.getElementById("settingsImageDownload").checked,
            video_download: document.getElementById("settingsVideoDownload").checked,
            live_download: document.getElementById("settingsLiveDownload").checked,
            video_cover_download: document.getElementById("settingsVideoCoverDownload").checked,
            image_format: document.getElementById("settingsImageFormat").value,
            video_preference: document.getElementById("settingsVideoPreference").value,
            note_format: document.getElementById("settingsNoteFormat").value,
            folder_mode: document.getElementById("settingsFolderMode").checked,
            author_archive: document.getElementById("settingsAuthorArchive").checked,
            download_record: document.getElementById("settingsDownloadRecord").checked,
            record_data: document.getElementById("settingsRecordData").checked,
            write_mtime: document.getElementById("settingsWriteMtime").checked,
            cookie: document.getElementById("settingsCookie").value.trim(),
            impersonate: document.getElementById("settingsImpersonate").value.trim(),
            proxy: document.getElementById("settingsProxy").value.trim() || null,
            timeout: Number(document.getElementById("settingsTimeout").value || 10),
            max_retry: Number(document.getElementById("settingsMaxRetry").value || 5),
            avg_delay: Number(document.getElementById("settingsAvgDelay").value) || 6,
            chunk: chunkSize,
            language: document.getElementById("settingsLanguage").value,
            script_server: document.getElementById("settingsScriptServer").checked,
            proxy_download: document.getElementById("settingsProxyDownload").checked,
        };
    }

    // 设置项修改后自动保存：防抖后静默提交，避免与状态轮询争抢表单内容。
    let settingsSaveTimer = null;
    let settingsSaveBusy = false;

    async function saveSettingsQuietly() {
        if (settingsSaveBusy) return;
        settingsSaveBusy = true;
        try {
            const result = await nativeApi.save_settings(collectNativeSettings());
            if (!result.ok) throw new Error(result.error);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            showToast(message, "warning");
        } finally {
            settingsSaveBusy = false;
        }
    }

    function scheduleSettingsSave() {
        window.clearTimeout(settingsSaveTimer);
        settingsSaveTimer = window.setTimeout(() => void saveSettingsQuietly(), 600);
    }

    function bindSettingsAutoSave() {
        // 设置面板内所有可编辑控件变更后触发自动保存；命名格式编辑器已单独绑定。
        const controls = settingsPanel.querySelectorAll("input, select, textarea");
        controls.forEach((control) => {
            const eventType = control.tagName === "SELECT" || control.type === "checkbox"
                ? "change" : "input";
            control.addEventListener(eventType, () => {
                if (!settingsLoaded) return;
                scheduleSettingsSave();
            });
        });
        // 语言变更需要重建翻译后的命名格式控件，保存后重新拉取语言包。
        const language = document.getElementById("settingsLanguage");
        language.addEventListener("change", () => {
            if (!settingsLoaded) return;
            void runNativeAction(async () => {
                const result = await nativeApi.save_settings(collectNativeSettings());
                if (!result.ok) throw new Error(result.error);
                settingsLoaded = false;
                await refreshUiTranslations();
            });
        });
    }

    function renderNativeMonitor(monitor) {
        // 后端状态是监听模式的唯一来源，前端 monitorMode 仅作为交互状态镜像。
        const active = Boolean(monitor.active);
        const wasActive = monitorMode;
        monitorMode = active;
        document.querySelectorAll(".nav-item").forEach((button) => {
            button.disabled = active;
        });
        if (active !== wasActive) setView("monitor", {force: true});
        renderMonitorState(active);
        document.getElementById("monitorCreated").innerHTML = `${monitor.created} <small>${translateText(
            "unit.item")}</small>`;
    }

    function renderNativeAbout(about) {
        // 关于页的版本、发布类型和仓库信息均来自后端常量，避免在 HTML 中固化。
        const version = String(about.version);
        const release = String(about.release);
        document.getElementById("aboutVersion").textContent = [version, release].filter(Boolean).join(" ");
        document.getElementById("aboutAuthor").textContent = about.author;
        document.getElementById("aboutLicense").textContent = about.license;
        document.getElementById("aboutRepository").textContent = String(about.repository).replace(/^https?:\/\//, "");
        aboutLinks = about.links || Object.create(null);
        document.querySelectorAll("[data-about-key]").forEach((button) => {
            const key = button.dataset.aboutKey;
            const link = aboutLinks[key];
            if (!link) return;
            const value = button.querySelector("strong");
            if (value) {
                value.textContent = link.replace(/^https?:\/\//, "");
            }
        });
    }

    function applyNativeState(state) {
        // 应用一次完整状态快照；仅在 revision 变化时重新查询下载记录数据库。
        renderNativeTaskLists(state.tasks, state.files);
        const enabled = Boolean(state.history_enabled);
        const revision = Number(state.history_revision);
        const shouldRefreshHistory = enabled && (lastHistoryRevision !== revision || !historyEnabled);
        setHistoryEnabled(enabled);
        if (shouldRefreshHistory) {
            lastHistoryRevision = revision;
            void requestHistoryPage(historyPage || 1);
        } else if (!enabled) {
            lastHistoryRevision = revision;
        }
        renderNativeLogs(state.logs);
        applyNativeSettings(state.settings);
        renderNativeMonitor(state.monitor);
        renderNativeAbout(state.about);
    }

    async function refreshNativeState() {
        // 轮询期间禁止并发刷新，确保较新的状态快照不会被旧请求覆盖。
        if (bridgeRefreshBusy) return;
        bridgeRefreshBusy = true;
        try {
            applyNativeState(await nativeApi.get_state());
            return true;
        } catch (error) {
            showToast(translateText("update.failed"), "warning");
            return false;
        } finally {
            bridgeRefreshBusy = false;
        }
    }

    async function runNativeAction(action, options = {}) {
        const showLoading = options.loading === true;
        if (showLoading) startupScreen.hidden = false;
        // 写操作完成后立即刷新状态；异常直接显示实际原因，避免误用更新检查提示。
        try {
            await action();
            await refreshNativeState();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            showToast(message, "warning");
        } finally {
            if (showLoading) startupScreen.hidden = true;
        }
    }

    function startStatePolling() {
        // 用户确认免责声明后才开始轮询完整状态，避免未授权时触发下载器运行时逻辑。
        if (stateRefreshTimer) return;
        stateRefreshTimer = window.setInterval(() => void refreshNativeState(), 500);
    }

    function showDisclaimer() {
        // 免责声明是启动前阻塞确认项，只能通过底部两个按钮继续或退出。
        if (!disclaimerModal.open) disclaimerModal.showModal();
        window.requestAnimationFrame(() => {
            document.getElementById("acceptDisclaimer").focus({preventScroll: true});
        });
    }

    document.getElementById("acceptDisclaimer").addEventListener("click", () => {
        void (async () => {
            try {
                await nativeApi.accept_disclaimer();
                disclaimerModal.close();
                await refreshNativeState();
                startStatePolling();
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                showToast(message, "warning");
            }
        })();
    });

    document.getElementById("declineDisclaimer").addEventListener("click", () => {
        void (async () => {
            try {
                await nativeApi.decline_disclaimer();
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                showToast(message, "warning");
            }
        })();
    });

    // 事件代理统一把桌面端操作转发到 PyWebView API。
    document.addEventListener("click", (event) => {
        const button = event.target.closest("button");
        if (!button) return;
        const id = button.id;
        const taskButton = button.closest("[data-action='cancel']");
        if (taskButton) {
            const taskId = taskButton.closest(".queue-item")?.dataset.taskId;
            if (!taskId) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            void runNativeAction(async () => {
                const cancelled = await nativeApi.cancel_task(taskId);
                if (!cancelled) showToast(
                    translateText("toast.cannot_cancel"), "warning");
            });
            return;
        }
        if (button.dataset.aboutKey) {
            event.preventDefault();
            event.stopImmediatePropagation();
            void runNativeAction(async () => {
                const opened = await nativeApi.open_url(aboutLinks[button.dataset.aboutKey]);
                if (!opened) throw new Error(translateText("toast.browser_unavailable"));
            });
            return;
        }
        if (id === "browseWorkPath") {
            event.preventDefault();
            event.stopImmediatePropagation();
            void runNativeAction(async () => {
                const input = document.getElementById("settingsWorkPath");
                const selected = await nativeApi.browse_directory(input.value);
                if (selected) input.value = selected;
            });
        } else if (id === "confirmDeleteHistory") {
            event.preventDefault();
            event.stopImmediatePropagation();
            void runNativeAction(async () => {
                const ids = selectedHistoryIds();
                if (ids.length === 0) return;
                const result = await nativeApi.delete_history_records(ids, historySearch.value, historyPage);
                recordModal.close();
                renderNativeHistoryPage(result);
                showToast(formatTranslated("history.deleted_selected", [ids.length]));
            });
        } else if (id === "clearFinished") {
            event.preventDefault();
            event.stopImmediatePropagation();
            void runNativeAction(async () => {
                await nativeApi.clear_finished();
            });
        } else if (id === "openDownloadFolder") {
            event.preventDefault();
            event.stopImmediatePropagation();
            void runNativeAction(async () => {
                const opened = await nativeApi.open_download_folder();
                if (!opened) throw new Error(translateText("toast.folder_unavailable"));
            });
        } else if (id === "pageCheckUpdate") {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (pageCheckUpdate.disabled) return;
            setUpdateChecking(true);
            setUpdateResult(translateText("update.checking"), "info");
            void (async () => {
                try {
                    const result = await nativeApi.check_update();
                    if (result.status !== "ok") {
                        setUpdateResult(result.message, "warning");
                        return;
                    }
                    const updateAvailable = ["update_available", "stable_available", "development_current"].includes(
                        result.kind);
                    const tone = updateAvailable ? "warning" : "success";
                    const title = result.title;
                    setUpdateResult(`${title}: ${result.message}`, tone);
                } catch (error) {
                    const message = error?.message || String(error);
                    setUpdateResult(`${translateText("update.failed")}: ${message}`, "error");
                } finally {
                    setUpdateChecking(false);
                }
            })();
        }
    }, true);

    function connectNativeBridge() {
        // pywebviewready 触发后先加载语言包；未同意免责声明时不进入状态轮询。
        nativeApi = window.pywebview.api;
        void (async () => {
            await refreshUiTranslations();
            startupScreen.hidden = true;
            const disclaimer = await nativeApi.get_disclaimer();
            if (!disclaimer.accepted) {
                showDisclaimer();
                return;
            }
            await refreshNativeState();
            startStatePolling();
        })().catch((error) => {
            startupScreen.hidden = true;
            showToast(translateText("toast.language_load_failed"), "warning");
        });
    }

    window.addEventListener("pywebviewready", connectNativeBridge);
})();
