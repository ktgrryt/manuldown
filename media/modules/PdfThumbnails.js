const THUMBNAIL_WIDTH = 128;
const MAX_CACHED_THUMBNAILS = 24;

/** A second view of the same PDF, with one small render at a time. Main pages
 * always get the first frame; scrolling a long sidebar never renders it all. */
export class PdfThumbnails {
    constructor(container, { navigate, pageCanvas }) {
        this.container = container;
        this.navigate = navigate;
        this.pageCanvas = pageCanvas;
        this.document = null;
        this.buttons = [];
        this.nearby = new Set();
        this.cache = new Map();
        this.failed = new Set();
        this.currentPage = 1;
        this.generation = 0;
        this.ready = false;
        this.visible = true;
        this.active = null;
        this.scheduled = null;
        this.observer = null;
        container.addEventListener('keydown', event => this.onKeyDown(event));
    }

    setDocument(pdf, viewport) {
        this.suspend();
        this.generation++;
        this.active = null;
        this.observer?.disconnect();
        this.nearby.clear();
        for (const number of [...this.cache.keys()]) this.release(number);
        this.failed.clear();
        this.document = pdf;
        this.buttons = Array.from({ length: pdf.numPages }, (_, index) => {
            const number = index + 1;
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'pdf-thumbnail';
            button.dataset.page = String(number);
            button.setAttribute('aria-label', `Go to page ${number}`);
            button.title = button.getAttribute('aria-label');
            button.tabIndex = -1;
            const sheet = document.createElement('span');
            sheet.className = 'thumbnail-sheet';
            sheet.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
            sheet.setAttribute('aria-hidden', 'true');
            const caption = document.createElement('span');
            caption.className = 'thumbnail-number';
            caption.textContent = String(number);
            button.append(sheet, caption);
            button.addEventListener('click', () => this.navigate(number));
            return button;
        });
        this.container.replaceChildren(...this.buttons);
        this.selectPage(Math.min(this.currentPage, pdf.numPages), false);
        this.observer = new window.IntersectionObserver(entries => {
            for (const entry of entries) {
                const number = Number(entry.target.dataset.page);
                if (entry.isIntersecting) this.nearby.add(number);
                else this.nearby.delete(number);
            }
            this.trimCache();
            this.schedule();
        }, { root: this.container, rootMargin: '300px' });
        for (const button of this.buttons) this.observer.observe(button);
    }

    selectPage(number, reveal = true) {
        const selected = this.buttons[number - 1];
        if (!selected) return;
        const previous = this.buttons[this.currentPage - 1];
        if (previous && previous !== selected) {
            previous.removeAttribute('aria-current');
            previous.tabIndex = -1;
        }
        this.currentPage = number;
        selected.setAttribute('aria-current', 'page');
        selected.tabIndex = 0;
        if (reveal && this.visible) {
            // Scroll only the sidebar, never the outer Webview or PDF pages.
            const area = this.container.getBoundingClientRect();
            const box = selected.getBoundingClientRect();
            if (box.top < area.top + 12) this.container.scrollTop += box.top - area.top - 12;
            else if (box.bottom > area.bottom - 12) this.container.scrollTop += box.bottom - area.bottom + 12;
        }
    }

    onKeyDown(event) {
        const button = event.target.closest('.pdf-thumbnail');
        if (!button || event.altKey || event.ctrlKey || event.metaKey) return;
        const number = Number(button.dataset.page);
        const next = { ArrowUp: number - 1, ArrowDown: number + 1, Home: 1, End: this.buttons.length }[event.key];
        if (next === undefined) return;
        event.preventDefault();
        const target = Math.max(1, Math.min(this.buttons.length, next));
        this.buttons[target - 1].focus({ preventScroll: true });
        this.navigate(target);
    }

    setVisible(visible) {
        this.visible = visible;
        if (visible) {
            this.selectPage(this.currentPage);
            this.schedule();
        } else this.cancelWork();
    }

    suspend() {
        this.ready = false;
        this.cancelWork();
    }

    resume() {
        this.ready = true;
        this.schedule();
    }

    cancelWork() {
        if (this.scheduled !== null) {
            if (window.cancelIdleCallback) window.cancelIdleCallback(this.scheduled);
            else clearTimeout(this.scheduled);
            this.scheduled = null;
        }
        this.active?.task?.cancel();
    }

    schedule() {
        if (!this.ready || !this.visible || !this.document || this.active || this.scheduled !== null) return;
        const run = () => {
            this.scheduled = null;
            if (!this.ready || !this.visible || this.active) return;
            const number = [...this.nearby].filter(page => !this.cache.has(page) && !this.failed.has(page))
                .sort((a, b) => Math.abs(a - this.currentPage) - Math.abs(b - this.currentPage))[0];
            if (number === undefined) return;
            const job = { number, document: this.document, generation: this.generation, task: null };
            this.active = job;
            void this.render(job).finally(() => {
                if (this.active === job) { this.active = null; this.schedule(); }
            });
        };
        this.scheduled = window.requestIdleCallback ? window.requestIdleCallback(run, { timeout: 500 }) : setTimeout(run, 16);
    }

    async render(job) {
        let canvas;
        try {
            const page = await job.document.getPage(job.number);
            if (job.generation !== this.generation || !this.ready || !this.visible) return;
            const viewport = page.getViewport({ scale: THUMBNAIL_WIDTH / page.getViewport({ scale: 1 }).width });
            const outputScale = Math.min(window.devicePixelRatio || 1, 2);
            canvas = document.createElement('canvas');
            canvas.width = Math.ceil(viewport.width * outputScale);
            canvas.height = Math.ceil(viewport.height * outputScale);
            const context = canvas.getContext('2d');
            const source = this.pageCanvas(job.number);
            if (source?.width) {
                context.drawImage(source, 0, 0, canvas.width, canvas.height);
            } else {
                job.task = page.render({ canvasContext: context, viewport,
                    transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0], background: '#ffffff' });
                await job.task.promise;
            }
            if (job.generation !== this.generation || !this.ready || !this.visible) return;
            const button = this.buttons[job.number - 1];
            button.querySelector('.thumbnail-sheet').replaceChildren(canvas);
            button.dataset.rendered = 'true';
            this.cache.set(job.number, canvas);
            canvas = null;
            this.trimCache();
        } catch (error) {
            if (job.generation === this.generation && error.name !== 'RenderingCancelledException') {
                this.failed.add(job.number);
                this.buttons[job.number - 1].title = 'Thumbnail unavailable. Click to open the page.';
            }
        } finally {
            if (canvas) { canvas.width = 0; canvas.height = 0; }
        }
    }

    release(number) {
        const canvas = this.cache.get(number);
        if (canvas) { canvas.width = 0; canvas.height = 0; canvas.remove(); }
        this.cache.delete(number);
        delete this.buttons[number - 1]?.dataset.rendered;
    }

    trimCache() {
        for (const number of this.cache.keys()) {
            if (this.cache.size <= MAX_CACHED_THUMBNAILS) break;
            if (!this.nearby.has(number) && number !== this.currentPage) this.release(number);
        }
    }

    dispose() {
        this.suspend();
        this.generation++;
        this.observer?.disconnect();
        for (const number of [...this.cache.keys()]) this.release(number);
        this.document = null;
    }
}
