// @ts-nocheck
import { calloutDialects, fencedDescriptor, gitbookCloser, matchesFencedCloser, mystHasOptions, resolveCalloutService, supportsFencedType } from '../../src/editor/CalloutFormats';
export { resolveCalloutService };

// Loaded callouts use the host Markdown parser. These deliberately narrower
// shortcuts only wrap complete declarations and move existing editable nodes.
const variants = Object.assign(Object.create(null), {
    note: 'note', info: 'note', abstract: 'note', summary: 'note', tldr: 'note',
    todo: 'note', example: 'note', quote: 'note', cite: 'note',
    tip: 'tip', hint: 'tip', success: 'tip', check: 'tip', done: 'tip',
    important: 'important', question: 'important', help: 'important', faq: 'important',
    warning: 'warning', warn: 'warning', caution: 'caution', attention: 'warning',
    danger: 'caution', error: 'caution', failure: 'caution', fail: 'caution',
    missing: 'caution', bug: 'caution'
});
const containerTypes = new Set(['note', 'tip', 'info', 'warning', 'danger', 'important', 'caution']);
const metadataNames = ['source', 'header', 'footer', 'format', 'type', 'variant'];
const elementOf = node => node?.nodeType === 1 ? node : node?.parentElement;
const encode = (value, view) => view.btoa(Array.from(new view.TextEncoder().encode(value), byte => String.fromCharCode(byte)).join(''));
const decode = (value, view) => {
    if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
    try {
        const bytes = Uint8Array.from((view.atob || globalThis.atob)(value), character => character.charCodeAt(0));
        const text = new (view.TextDecoder || globalThis.TextDecoder)('utf-8', { fatal: true }).decode(bytes);
        return encode(text, view) === value ? text : null;
    } catch { return null; }
};

/** Only the type token changes; titles, folding signs and delimiter spelling stay intact. */
function typeDescriptor(header, format) {
    if (!header || /[\r\n]/.test(header)) return null;
    if (format === 'quote') {
        const match = /^( {0,3}>[ \t]?\[!)([A-Za-z][A-Za-z0-9-]*)(\]([+-]?)(?:[ \t]+(.*))?[ \t]*)$/.exec(header);
        if (!match || !variants[match[2].toLowerCase()]) return null;
        const githubTypes = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'];
        const uppercase = match[2] === match[2].toUpperCase();
        const options = uppercase && githubTypes.includes(match[2]) ? githubTypes.slice()
            : Object.keys(variants).map(type => uppercase ? type.toUpperCase() : type);
        const existing = options.findIndex(type => type.toLowerCase() === match[2].toLowerCase());
        if (existing >= 0) options[existing] = match[2];
        else options.unshift(match[2]);
        return { current: match[2], options, custom: !!match[5]?.trim(), title: match[5]?.trim(), fold: match[4],
            dialect: uppercase && githubTypes.includes(match[2]) && !match[4] ? 'github' : 'obsidian',
            rewrite: type => match[1] + type + match[3],
            variant: type => variants[type.toLowerCase()] };
    }
    if (format === 'mkdocs') {
        const match = /^( {0,3}(?:!!!|\?\?\?\+?)[ \t]+)([a-z]+)((?:[ \t]+"([^"\r\n]*)")?[ \t]*)$/.exec(header);
        if (!match || !variants[match[2]]) return null;
        return { current: match[2], options: Object.keys(variants), custom: match[4] !== undefined, title: match[4], dialect: 'mkdocs',
            fold: header.trimStart().startsWith('???+') ? '+' : header.trimStart().startsWith('???') ? '-' : '',
            rewrite: type => match[1] + type + match[3], variant: type => variants[type] };
    }
    if (format !== 'container') {
        const spec = fencedDescriptor(header);
        return spec?.dialect === format ? spec : null;
    }
    const match = /^( {0,3}:{3,}[ \t]*)([a-z]+)(.*)$/.exec(header);
    if (!match) return null;
    const [, prefix, type, tail] = match;
    if (type === 'note' && /^(?:[ \t]+(?:info|warn|alert))?[ \t]*$/.test(tail)) {
        const subtype = /^([ \t]+)(info|warn|alert)([ \t]*)$/.exec(tail);
        return { current: subtype?.[2] || 'info', label: subtype?.[2] || 'note', options: ['info', 'warn', 'alert'], custom: false, dialect: 'qiita',
            rewrite: value => subtype ? prefix + 'note' + subtype[1] + value + subtype[3]
                : prefix + 'note' + (value === 'info' ? '' : ' ' + value) + tail,
            variant: value => value === 'warn' ? 'warning' : value === 'alert' ? 'caution' : 'note' };
    }
    if (type === 'message' && /^(?:[ \t]+alert)?[ \t]*$/.test(tail)) {
        const alert = /^([ \t]+)alert([ \t]*)$/.exec(tail);
        return { current: alert ? 'alert' : 'message', options: ['message', 'alert'], custom: false, dialect: 'zenn',
            rewrite: value => prefix + 'message' + (value === 'alert' ? (alert?.[1] || ' ') + 'alert' : '') + (alert?.[2] ?? tail),
            variant: value => value === 'alert' ? 'caution' : 'note' };
    }
    if (!containerTypes.has(type) || !containerHeader(header)) return null;
    const title = tail.startsWith('[') ? tail.slice(1, tail.lastIndexOf(']')) : tail.trim();
    return { current: type, options: Array.from(containerTypes), custom: !!tail.trim(), title, dialect: 'container',
        rewrite: value => prefix + value + tail, variant: value => variants[value] };
}

/** Map the visual meaning to a supported declaration in the chosen dialect. */
function dialectDeclaration(descriptor, dialect) {
    if (!calloutDialects.some(option => option.value === dialect) || descriptor.dialect === dialect) return null;
    if (descriptor.keepAttributes || (descriptor.custom && ['qiita', 'zenn', 'gitbook'].includes(dialect))) return null;
    const variant = descriptor.variant(descriptor.current), originalType = descriptor.current.toLowerCase();
    const defaults = { note: 'note', tip: 'tip', important: 'important', warning: 'warning', caution: 'caution' };
    let type = defaults[variant], header, footer = '', format;
    if (dialect === 'github' || dialect === 'obsidian') {
        type = dialect === 'github' ? type.toUpperCase() : variants[originalType] ? originalType : type;
        const fold = dialect === 'obsidian' ? descriptor.fold || '' : '';
        header = `> [!${type}]${fold}${descriptor.custom ? ' ' + descriptor.title : ''}`;
        format = 'quote';
    } else if (dialect === 'gitbook') {
        type = { note: 'info', tip: 'success', important: 'info', warning: 'warning', caution: 'danger' }[variant];
        header = `{% hint style="${type}" %}`; footer = '{% endhint %}'; format = dialect;
    } else if (dialect === 'myst') {
        if (supportsFencedType(dialect, originalType)) type = originalType;
        header = ':::{' + type + '}' + (descriptor.custom ? ' ' + descriptor.title : '');
        footer = ':::'; format = dialect;
    } else if (dialect === 'quarto') {
        const quote = descriptor.title?.includes('"') ? "'" : '"';
        if (descriptor.custom && descriptor.title.includes(quote)) return null;
        header = '::: {.callout-' + type + (descriptor.custom ? ' title=' + quote + descriptor.title + quote : '') + '}';
        footer = ':::'; format = dialect;
    } else if (dialect === 'mkdocs') {
        if (descriptor.custom && /["\r\n]/.test(descriptor.title)) return null;
        type = variants[originalType] ? originalType : type;
        header = `${descriptor.fold === '+' ? '???+' : descriptor.fold === '-' ? '???' : '!!!'} ${type}${descriptor.custom ? ' "' + descriptor.title + '"' : ''}`;
        format = 'mkdocs';
    } else {
        format = 'container'; footer = ':::';
        if (dialect === 'qiita') {
            type = variant === 'warning' ? 'warn' : variant === 'caution' ? 'alert' : 'info';
            header = ':::note ' + type;
        } else if (dialect === 'zenn') {
            type = variant === 'warning' || variant === 'caution' ? 'alert' : 'message';
            header = ':::message' + (type === 'alert' ? ' alert' : '');
        } else {
            type = containerTypes.has(originalType) ? originalType : type;
            // A bare :::note is interpreted as Qiita when it is reopened.
            if (type === 'note' && !descriptor.custom) type = 'info';
            header = ':::' + type + (descriptor.custom ? '[' + descriptor.title + ']' : '');
        }
    }
    const next = typeDescriptor(header, format);
    // Empty or unrepresentable custom titles must not silently disappear.
    if (!next || (descriptor.custom && (!next.custom || next.title !== descriptor.title))) return null;
    return { header, footer, format, type, variant: next.variant(next.current) };
}

function quoteHeader(line) {
    const match = /^(?: {0,3}>[ \t]?)?\[!([A-Za-z]+)\]([+-]?)(?:[ \t]+(.*))?$/.exec(line);
    if (!match || !variants[match[1].toLowerCase()]) return null;
    return { header: line.startsWith('>') || /^ {1,3}>/.test(line) ? line : '> ' + line,
        footer: '', format: 'quote', type: match[1], variant: variants[match[1].toLowerCase()],
        title: match[3]?.trim() || match[1] };
}

function containerHeader(line) {
    const match = /^ {0,3}(:{3,})[ \t]*([a-z]+)(.*)$/.exec(line);
    if (!match) return null;
    const [, fence, kind, tail] = match;
    let type = kind, variant = variants[kind], title = kind;
    if (kind === 'note' && /^(?:[ \t]+(?:info|warn|alert))?[ \t]*$/.test(tail)) {
        type = tail.trim() || 'note';
        variant = type === 'warn' ? 'warning' : type === 'alert' ? 'caution' : 'note';
        title = type;
    } else if (kind === 'message' && /^(?:[ \t]+alert)?[ \t]*$/.test(tail)) {
        type = tail.trim() || 'message'; variant = type === 'alert' ? 'caution' : 'note';
        title = type;
    } else if (containerTypes.has(kind)) {
        const customTitle = /^(?:[ \t]+([^\r\n]+)|\[([^\]\r\n]*)\])?[ \t]*$/.exec(tail);
        if (!customTitle) return null;
        title = customTitle[1] ?? customTitle[2] ?? type;
    } else return null;
    return { header: line, footer: fence, format: 'container', type, variant, title, fence };
}

function fencedBlockSpec(header, footer, format) {
    const spec = fencedDescriptor(header);
    if (!spec || (format && spec.dialect !== format) || !matchesFencedCloser(spec, footer)) return null;
    return { header, footer, format: spec.dialect, type: spec.current, variant: spec.variant(spec.current),
        title: spec.title ?? spec.current };
}

/** Clipboard declarations are data, not permission to restore arbitrary source HTML. */
function clipboardCalloutSpec(header, footer, format) {
    if (header === null || footer === null || /[\r\n]/.test(header + footer)) return null;
    let spec;
    if (format === 'quote' && /^ {0,3}>/.test(header) && footer === '') spec = quoteHeader(header);
    else if (format === 'container') {
        const opening = /^ {0,3}(:{3,})/.exec(header);
        const closing = /^ {0,3}(:{3,})[ \t]*$/.exec(footer);
        if (!opening || !closing || closing[1].length < opening[1].length) return null;
        spec = containerHeader(header);
    } else if (format === 'mkdocs' && footer === '') {
        const match = /^ {0,3}(?:!!!|\?\?\?\+?)[ \t]+([a-z]+)(?:[ \t]+"([^"\r\n]*)")?[ \t]*$/.exec(header);
        if (match && variants[match[1]]) spec = {
            header, format, type: match[1], variant: variants[match[1]], title: match[2] ?? match[1],
        };
    } else if (format === 'gitbook' || format === 'myst' || format === 'quarto') {
        return fencedBlockSpec(header, footer, format);
    }
    return spec ? { ...spec, footer } : null;
}

/** The visual wrapper is shared with MarkdownDocument and the insert commands. */
export class CalloutManager {
    constructor(editor, options = {}) {
        this.editor = editor;
        this.beforeChange = options.beforeChange || (() => {});
        this.onChange = options.onChange || (() => {});
        this.onNavigate = options.onNavigate || (() => {});
        this.onServiceSelected = options.onServiceSelected || (() => {});
        this.isComposing = options.isComposing || (() => false);
        this.cursorManager = options.cursorManager || null;
        this.moveToBlockGap = options.moveToBlockGap || null;
        this.deleteBlock = options.deleteBlock || null;
        this.typePicker = null;
        // Delegate handlers so controls restored by Undo/Redo remain usable.
        this.editor.addEventListener('mousedown', event => {
            if (elementOf(event.target)?.closest('.mdw-callout-format-toggle')) event.preventDefault();
        });
        this.editor.addEventListener('keydown', event => {
            const button = elementOf(event.target)?.closest('.mdw-callout-format-toggle');
            if (!button || event.isComposing || event.keyCode === 229 || this.isComposing() ||
                event.ctrlKey || event.metaKey || event.altKey) return;
            const direction = { ArrowLeft: 'backward', ArrowRight: 'forward', ArrowUp: 'up', ArrowDown: 'down' }[event.key];
            if (!event.shiftKey) {
                if (direction && this.handleTypeNavigation(this.selection, direction)) event.preventDefault();
                else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.openFormatPicker(button); }
                else if (event.key === 'Escape') { event.preventDefault(); this.moveToBody(button.parentElement, this.selection); }
            }
            if (event.key === 'Tab') {
                event.preventDefault();
                if (event.shiftKey) this.selectTypeLabel(button); else this.moveToBody(button.parentElement, this.selection);
            }
            if (event.defaultPrevented) this.onNavigate();
            // A focused control must not trigger the editor's text handlers.
            event.stopImmediatePropagation();
        }, true);
        this.editor.addEventListener('click', event => {
            const formatButton = elementOf(event.target)?.closest('.mdw-callout-format-toggle');
            if (formatButton && this.editor.contains(formatButton)) {
                event.preventDefault(); event.stopPropagation();
                if (this.pickerKind === 'format' && this.pickerTitle?.parentElement === formatButton.parentElement) this.closeTypePicker(true);
                else this.openFormatPicker(formatButton);
                return;
            }
            const title = elementOf(event.target)?.closest('.mdw-callout-title');
            if (title && this.editor.contains(title) && !this.isComposing()) {
                event.preventDefault();
                event.stopPropagation();
                this.openTypePicker(title);
            }
        });
        this.editor.addEventListener('compositionstart', () => {
            // Chromium moves IME input from a selected readonly label into its
            // body. Clear only the visual indicator before composition owns the
            // text/range, so the body caret stays visible throughout conversion.
            this.editor.querySelectorAll('.mdw-callout-title.nav-selected').forEach(title => title.classList.remove('nav-selected'));
        });
        this.document.addEventListener('mousedown', event => {
            if (this.typePicker && !this.typePicker.contains(event.target) &&
                !this.pickerTitle?.contains(event.target) &&
                !elementOf(event.target)?.closest('.mdw-callout-format-toggle')) this.closeTypePicker(false);
        });
        for (const eventName of ['paste', 'cut']) this.editor.addEventListener(eventName, event => {
            const title = this.getSelectedTypeLabel();
            if (!title && !this.getFocusedFormatButton()) return;
            event.preventDefault(); event.stopImmediatePropagation();
            if (eventName === 'paste' && title) this.openTypePicker(title);
        }, true);
    }

    get document() { return this.editor.ownerDocument; }
    get selection() { return this.document.defaultView.getSelection?.(); }
    getRange() { return this.selection?.rangeCount ? this.selection.getRangeAt(0) : null; }

    getTypeBlock(node) {
        const block = elementOf(node)?.closest('[data-mdw-callout="true"]');
        return block && this.editor.contains(block) ? block : null;
    }

    getTypeDescriptor(block) {
        if (!block || !this.editor.contains(block)) return null;
        return typeDescriptor(decode(block.getAttribute('data-mdw-callout-header'), this.document.defaultView),
            block.getAttribute('data-mdw-callout-format'));
    }

    getTypeOptions(block) { return this.getTypeDescriptor(this.getTypeBlock(block))?.options.slice() || []; }

    getSelectedTypeLabel(selection = this.selection) {
        if (!selection?.rangeCount) return null;
        const range = selection.getRangeAt(0);
        if (range.collapsed || range.startContainer !== range.endContainer ||
            range.endOffset !== range.startOffset + 1) return null;
        const title = range.startContainer.childNodes[range.startOffset];
        return title?.nodeType === 1 && title.classList.contains('mdw-callout-title') &&
            title.parentElement?.matches('[data-mdw-callout="true"]') && this.editor.contains(title) ? title : null;
    }

    selectTypeLabel(node, selection = this.selection) {
        const block = this.getTypeBlock(node);
        const title = block && Array.from(block.children).find(child => child.classList.contains('mdw-callout-title'));
        if (!title || !selection || !this.getTypeDescriptor(block)) return false;
        this.editor.focus?.({ preventScroll: true });
        const range = this.document.createRange();
        range.selectNode(title);
        selection.removeAllRanges(); selection.addRange(range);
        this.refresh();
        return true;
    }

    getFocusedFormatButton() {
        const button = this.document.activeElement;
        return button?.classList?.contains('mdw-callout-format-toggle') && this.editor.contains(button) ? button : null;
    }

    focusFormatButton(node, selection = this.selection) {
        const block = this.getTypeBlock(node);
        const button = block && Array.from(block.children).find(child => child.classList.contains('mdw-callout-format-toggle'));
        if (!button || !this.getTypeDescriptor(block)) return false;
        button.focus?.({ preventScroll: true });
        selection?.removeAllRanges();
        this.refresh();
        return true;
    }

    refresh() {
        if (this.typePicker && (!this.editor.contains(this.pickerTitle) ||
            this.pickerHeader !== this.pickerTitle.parentElement.getAttribute('data-mdw-callout-header'))) this.closeTypePicker(false);
        const selected = this.getSelectedTypeLabel();
        this.editor.querySelectorAll('[data-mdw-callout="true"] > .mdw-callout-title').forEach(title => {
            const descriptor = this.getTypeDescriptor(title.parentElement);
            if (descriptor && !descriptor.custom) {
                const label = descriptor.label ?? descriptor.current;
                if (title.textContent !== label) title.textContent = label;
            }
            title.classList.toggle('nav-selected', title === selected);
            title.setAttribute('role', 'button'); title.setAttribute('tabindex', '-1');
            title.setAttribute('aria-haspopup', 'listbox');
            title.setAttribute('aria-label', `Change callout type (${descriptor?.current || ''})`);
            title.setAttribute('aria-expanded', this.typePicker && this.pickerKind === 'type' && title === this.pickerTitle ? 'true' : 'false');
            this.refreshFormatButton(title.parentElement, descriptor);
        });
    }

    refreshFormatButton(block, descriptor) {
        let button = Array.from(block.children).find(child => child.classList.contains('mdw-callout-format-toggle'));
        if (!descriptor) { button?.remove(); return; }
        if (!button) {
            button = this.document.createElement('button'); button.type = 'button';
            button.className = 'mdw-callout-format-toggle';
            button.setAttribute('contenteditable', 'false'); button.setAttribute('data-exclude-from-markdown', 'true');
            button.setAttribute('aria-haspopup', 'listbox');
            block.insertBefore(button, Array.from(block.children).find(child => child.classList.contains('mdw-callout-content')) || null);
        }
        // Older history snapshots used a text glyph for this generated control.
        if (button.textContent) button.textContent = '';
        const label = calloutDialects.find(option => option.value === descriptor.dialect)?.label;
        const description = `Callout format: ${label}`;
        if (button.title !== description) button.title = description;
        if (button.getAttribute('aria-label') !== description) button.setAttribute('aria-label', description);
        const expanded = this.typePicker && this.pickerKind === 'format' && this.pickerTitle?.parentElement === block ? 'true' : 'false';
        if (button.getAttribute('aria-expanded') !== expanded) button.setAttribute('aria-expanded', expanded);
    }

    changeFormat(node, dialect) {
        const block = this.getTypeBlock(node), descriptor = this.getTypeDescriptor(block);
        if (this.isComposing() || !descriptor) return false;
        if (descriptor.dialect === dialect) {
            this.onServiceSelected(dialect);
            return false;
        }
        const next = dialectDeclaration(descriptor, dialect);
        if (!next) return false;
        this.beforeChange();
        for (const name of ['header', 'footer']) block.setAttribute('data-mdw-callout-' + name, encode(next[name], this.document.defaultView));
        for (const name of ['format', 'type', 'variant']) block.setAttribute('data-mdw-callout-' + name, next[name]);
        this.pickerHeader = block.getAttribute('data-mdw-callout-header');
        this.onServiceSelected(dialect);
        this.refresh(); this.finishChange();
        return true;
    }

    changeType(node, type) {
        const block = this.getTypeBlock(node), descriptor = this.getTypeDescriptor(block);
        if (this.isComposing() || !descriptor || !descriptor.options.includes(type) || descriptor.current === type) return false;
        const header = descriptor.rewrite(type), format = block.getAttribute('data-mdw-callout-format');
        const next = typeDescriptor(header, format);
        if (!next) return false;
        this.beforeChange();
        block.setAttribute('data-mdw-callout-header', encode(header, this.document.defaultView));
        block.setAttribute('data-mdw-callout-type', type);
        block.setAttribute('data-mdw-callout-variant', descriptor.variant(type));
        const title = Array.from(block.children).find(child => child.classList.contains('mdw-callout-title'));
        if (title && !descriptor.custom) title.textContent = type;
        this.pickerHeader = block.getAttribute('data-mdw-callout-header');
        this.refresh(); this.finishChange();
        return true;
    }

    openFormatPicker(node) { return this.openTypePicker(node, 'format'); }

    openTypePicker(node, kind = 'type') {
        if (this.isComposing()) return false;
        const block = this.getTypeBlock(node), descriptor = this.getTypeDescriptor(block);
        if (!descriptor || !(kind === 'format' ? this.focusFormatButton(block) : this.selectTypeLabel(block))) return false;
        this.closeTypePicker(false);
        const title = Array.from(block.children).find(child => child.classList.contains('mdw-callout-title'));
        const choices = kind === 'format' ? calloutDialects.map(option => ({ ...option,
            disabled: option.value !== descriptor.dialect && !dialectDeclaration(descriptor, option.value) }))
            : descriptor.options.map(value => ({ value, label: value }));
        const currentValue = kind === 'format' ? descriptor.dialect : descriptor.current;
        const attribute = kind === 'format' ? 'data-callout-dialect' : 'data-callout-type';
        const picker = this.document.createElement('div');
        picker.className = kind === 'format' ? 'mdw-callout-format-picker' : 'mdw-callout-type-picker'; picker.setAttribute('role', 'listbox');
        picker.setAttribute('aria-label', kind === 'format' ? 'Callout format' : 'Callout type');
        this.pickerKind = kind;
        this.pickerTitle = title; this.pickerHeader = block.getAttribute('data-mdw-callout-header'); this.typePicker = picker;
        const choose = value => {
            if (kind === 'format') this.changeFormat(block, value); else this.changeType(block, value);
            this.closeTypePicker(true);
        };
        this.pickerIndex = Math.max(0, choices.findIndex(option => option.value === currentValue));
        const activateOption = (index, focus = false) => {
            this.pickerIndex = index;
            Array.from(picker.children).forEach((option, position) => option.classList.toggle('active', position === index));
            if (focus && this.document.activeElement !== picker.children[index]) picker.children[index]?.focus();
        };
        choices.forEach(({ value, label, disabled }, index) => {
            const option = this.document.createElement('button'); option.type = 'button';
            option.className = 'mdw-callout-type-option'; option.textContent = label;
            option.setAttribute('role', 'option'); option.setAttribute(attribute, value);
            option.setAttribute('aria-selected', value === currentValue ? 'true' : 'false');
            option.disabled = !!disabled;
            if (disabled) { option.setAttribute('aria-disabled', 'true'); option.title = descriptor.keepAttributes ? 'This format cannot preserve the block attributes.' : 'This format cannot preserve the custom title.'; }
            option.addEventListener('mousedown', event => event.preventDefault());
            option.addEventListener('click', event => { event.preventDefault(); if (!disabled) choose(value); });
            option.addEventListener('focus', () => activateOption(index));
            option.addEventListener('mouseenter', () => { if (!disabled) activateOption(index, true); });
            option.addEventListener('mousemove', () => { if (!disabled) activateOption(index, true); });
            picker.appendChild(option);
        });
        this.pickerKeydown = event => {
            if (event.isComposing || event.keyCode === 229) return;
            const options = Array.from(picker.children).filter(option => !option.disabled);
            const focused = options.indexOf(this.document.activeElement), current = focused < 0 ? options.indexOf(picker.children[this.pickerIndex]) : focused;
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.closeTypePicker(true); }
            else if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
                event.preventDefault(); event.stopPropagation();
                const index = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
                    : (Math.max(0, current) + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
                activateOption(Array.from(picker.children).indexOf(options[index]), true);
            } else if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault(); event.stopPropagation();
                const option = options[Math.max(0, current)];
                if (option) choose(option.getAttribute(attribute));
            } else if (event.key === 'Tab') {
                event.preventDefault(); event.stopPropagation();
                this.closeTypePicker(true);
                if (event.shiftKey) this.selectTypeLabel(block);
                else if (kind === 'format') this.moveToBody(block, this.selection);
                else this.focusFormatButton(block);
                this.onNavigate();
            }
        };
        picker.addEventListener('keydown', this.pickerKeydown);
        this.document.body.appendChild(picker);
        const anchor = kind === 'format' ? Array.from(block.children).find(child => child.classList.contains('mdw-callout-format-toggle')) : title;
        const rect = anchor?.getBoundingClientRect?.();
        const view = this.document.defaultView;
        if (rect) {
            const viewportWidth = view.innerWidth || 800, viewportHeight = view.innerHeight || 600;
            const measured = picker.getBoundingClientRect?.();
            const width = measured?.width || 160, height = measured?.height || Math.min(200, choices.length * 28 + 10);
            const below = rect.bottom + 4;
            const top = below + height <= viewportHeight - 8 ? below : rect.top - height - 4;
            picker.style.left = `${Math.max(8, Math.min(kind === 'format' ? rect.right - width : rect.left, viewportWidth - width - 8))}px`;
            picker.style.top = `${Math.max(8, Math.min(top, viewportHeight - height - 8))}px`;
        }
        this.refresh();
        activateOption(this.pickerIndex, true);
        return true;
    }

    closeTypePicker(restoreSelection = true) {
        if (!this.typePicker) return false;
        const title = this.pickerTitle;
        const kind = this.pickerKind;
        this.typePicker.remove(); this.typePicker = null; this.pickerTitle = null; this.pickerKeydown = null; this.pickerKind = null;
        if (restoreSelection && this.editor.contains(title)) {
            if (kind === 'format') this.focusFormatButton(title); else this.selectTypeLabel(title);
        }
        else this.refresh();
        return true;
    }

    isVisualEdge(range, root, end, vertical) {
        const block = elementOf(range.startContainer)?.closest('p, li, pre, h1, h2, h3, h4, h5, h6');
        if (block?.tagName === 'PRE') return false;
        if (this.atEdge(range, root, end)) return true;
        if (!vertical) return false;
        const probe = range.cloneRange();
        if (!block || !root.contains(block)) return false;
        probe.setStart(block, end ? block.childNodes.length : 0); probe.collapse(true);
        if (!this.atEdge(probe, root, end)) return false;
        const lines = this.cursorManager?._getVisualLinesForBlock(block) || [];
        const rect = this.cursorManager?._getVisualCaretRectForRange(range);
        if (lines.length && rect) return this.cursorManager._isSameVisualLine(end ? lines[lines.length - 1] : lines[0], rect);
        const text = range.startContainer.nodeType === 3 ? range.startContainer.textContent : '';
        return !(end ? text.slice(range.startOffset) : text.slice(0, range.startOffset)).includes('\n');
    }

    moveToBody(block, selection, direction = 'down') {
        const content = Array.from(block.children).find(child => child.classList.contains('mdw-callout-content'));
        if (!content) return false;
        this.editor.focus?.({ preventScroll: true });
        let first = Array.from(content.children).find(child => !child.matches('[contenteditable="false"]')) || content;
        while (first.tagName === 'BLOCKQUOTE') {
            const child = Array.from(first.children).find(node => !node.matches('[contenteditable="false"]'));
            if (!child) break;
            first = child;
        }
        const leadingType = this.getBoundaryCallout(first);
        if (leadingType) return this.selectTypeLabel(leadingType, selection);
        if (first.matches('table, .md-table-wrapper')) {
            first = first.querySelector('th, td') || first;
        }
        if ((first.tagName === 'UL' || first.tagName === 'OL') && this.cursorManager?._placeCursorInFirstListItem(first, selection)) {
            // Lists containing only preserved source have no editable text.
            // A generic list cursor must not enter their read-only PRE/code.
            if (!elementOf(selection.getRangeAt(0).startContainer)?.closest('[contenteditable="false"]')) {
                this.refresh(); return true;
            }
        }
        if (this.cursorManager?.placeCursorAtLeadingImageLine(first, selection)) { this.refresh(); return true; }
        const text = this.cursorManager?._getFirstNavigableTextNode(first) || this.document.createTreeWalker(first, 4, {
            acceptNode: node => elementOf(node)?.closest('[contenteditable="false"]') ? 2 : 1
        }).nextNode();
        const boundary = !text && /^(UL|OL)$/.test(first.tagName) ? first.firstElementChild || first : first;
        const range = this.document.createRange();
        this.setStartOfBlock(range, boundary, text);
        range.collapse(true);
        selection.removeAllRanges(); selection.addRange(range); this.refresh();
        return true;
    }

    setStartOfBlock(range, block, text) {
        // Searching only for a text node skips an empty line before that text.
        const lineBreak = text && block.querySelector?.('br');
        if (lineBreak && (lineBreak.compareDocumentPosition(text) & this.document.defaultView.Node.DOCUMENT_POSITION_FOLLOWING)) {
            range.setStartBefore(lineBreak);
        } else {
            range.setStart(text || block, 0);
        }
    }

    getBoundaryCallout(node, backwards = false) {
        let current = node;
        while (current?.nodeType === 1) {
            if (current.matches('[data-mdw-callout="true"]')) return current;
            if (!/^(BLOCKQUOTE|UL|OL|LI)$/.test(current.tagName)) return null;
            current = this.navigableSibling(backwards ? current.lastChild : current.firstChild, backwards);
        }
        return null;
    }

    navigableSibling(node, backwards = false) {
        for (; node; node = backwards ? node.previousSibling : node.nextSibling) {
            if (node.nodeType === 3 ? node.textContent.trim() !== '' : node.nodeType === 1 &&
                !node.matches('[contenteditable="false"], [data-exclude-from-markdown="true"], [aria-hidden="true"]')) return node;
        }
        return null;
    }

    moveToBlockBoundary(node, selection, direction) {
        if (!node) return false;
        const backwards = direction === 'up' || direction === 'backward' || direction === 'left';
        const incoming = !backwards && this.getBoundaryCallout(node);
        if (incoming) return this.selectTypeLabel(incoming, selection);
        if (node.nodeType === 1) {
            node = this.cursorManager?._getCalloutBoundaryBlock(node, backwards ? 'up' : 'down') || node;
            while (node.tagName === 'BLOCKQUOTE') {
                const child = this.navigableSibling(backwards ? node.lastChild : node.firstChild, backwards);
                if (!child) break;
                node = child;
            }
            if (node.tagName === 'PRE' && node.querySelector('code')) {
                if (direction === 'down' && this.cursorManager?._selectCodeBlockLanguageLabel(node, selection)) { this.refresh(); return true; }
                const code = node.querySelector('code'), text = this.cursorManager?.getCodeBlockText(code);
                if (text !== undefined && this.cursorManager.setCodeBlockCursorOffset(code, selection,
                    backwards ? text.length - Number(text.endsWith('\n')) : 0)) { this.refresh(); return true; }
                node = code;
            }
            if (backwards && ((direction === 'up' && this.cursorManager?.placeCursorAtLastVisualLineStart(node, selection)) ||
                this.cursorManager?.placeCursorAtBlockEnd(node, selection))) { this.refresh(); return true; }
            if (!backwards && (/^(UL|OL)$/.test(node.tagName) && this.cursorManager?._placeCursorInFirstListItem(node, selection) ||
                this.cursorManager?.placeCursorAtLeadingImageLine(node, selection) ||
                this.cursorManager?._placeCursorBeforeLeadingInlineCode(node, selection))) { this.refresh(); return true; }
            if (!backwards && node.matches('table, .md-table-wrapper')) {
                const entry = direction === 'down' ? 'th, td' : '.md-table-edge-left';
                node = node.querySelector(entry) || node;
            }
        }
        const text = node.nodeType === 3 ? node : backwards
            ? this.cursorManager?._getLastNavigableTextNode(node) : this.cursorManager?._getFirstNavigableTextNode(node);
        const range = this.document.createRange();
        if (node.tagName === 'HR') range.selectNode(node);
        else {
            if (backwards) {
                const target = text || node;
                range.setStart(target, target.nodeType === 3 ? target.textContent.length : target.childNodes.length);
            } else {
                this.setStartOfBlock(range, node, text);
            }
            range.collapse(true);
        }
        selection.removeAllRanges(); selection.addRange(range); this.refresh();
        return true;
    }

    movePastCallout(block, selection, direction) {
        if (this.moveToBlockGap?.(block, 'down', selection)) { this.refresh(); return true; }
        for (let current = block; current && current !== this.editor; current = current.parentElement) {
            const next = this.navigableSibling(current.nextSibling);
            if (next) return this.moveToBlockBoundary(next, selection, direction);
        }
        const content = Array.from(block.children).find(child => child.classList.contains('mdw-callout-content'));
        return this.moveToBlockBoundary(this.navigableSibling(content?.lastChild, true), selection, 'backward');
    }

    moveVerticallyFromTable(wrapper, selection, direction) {
        const backwards = direction === 'up';
        const content = this.getContent(wrapper);
        for (let block = wrapper; block && block !== this.editor; block = block.parentElement) {
            const neighbor = this.navigableSibling(backwards ? block.previousSibling : block.nextSibling, backwards);
            if (neighbor) {
                const callout = this.getBoundaryCallout(neighbor, backwards);
                if (callout) return this.moveToBlockBoundary(callout, selection, direction);
                // Table navigation handles siblings in the same container.
                return !!content && block !== wrapper && this.moveToBlockBoundary(neighbor, selection, direction);
            }
            if (!content) return false;
            if (block.parentElement === content) {
                return backwards ? this.selectTypeLabel(content.parentElement, selection)
                    : this.movePastCallout(content.parentElement, selection, direction);
            }
        }
        return false;
    }

    handleBoundaryNavigation(selection, direction) {
        const range = selection.getRangeAt(0), node = range.startContainer;
        const container = elementOf(node);
        if (!range.collapsed || !container || !this.editor.contains(container) ||
            (node.nodeType === 3 && node.textContent.trim() !== '')) return false;
        const backwards = direction === 'up' || direction === 'backward' || direction === 'left';
        if (container.matches('[data-mdw-callout="true"]')) {
            const content = Array.from(container.children).find(child => child.classList.contains('mdw-callout-content'));
            if (!content) return false;
            const index = Array.prototype.indexOf.call(container.childNodes, content);
            const offset = node === container ? range.startOffset : Array.prototype.indexOf.call(container.childNodes, node);
            if (offset <= index) return backwards ? this.selectTypeLabel(container, selection) : this.moveToBody(container, selection);
            return backwards ? this.moveToBlockBoundary(this.navigableSibling(content.lastChild, true), selection, direction)
                : this.movePastCallout(container, selection, direction);
        }
        const content = container.classList.contains('mdw-callout-content') && this.getContent(container);
        if (!content && container !== this.editor) return false;
        const previous = this.navigableSibling(node.nodeType === 3 ? node.previousSibling : container.childNodes[range.startOffset - 1], true);
        const next = this.navigableSibling(node.nodeType === 3 ? node.nextSibling : container.childNodes[range.startOffset]);
        if (!content && ![previous, next].some(sibling => sibling?.nodeType === 1 && sibling.matches('[data-mdw-callout="true"]'))) return false;
        const target = backwards ? previous : next;
        if (target) return this.moveToBlockBoundary(target, selection, direction);
        if (content) return backwards ? this.selectTypeLabel(content.parentElement, selection)
            : this.movePastCallout(content.parentElement, selection, direction);
        const block = backwards ? next : previous;
        if (block?.nodeType === 1 && block.matches('[data-mdw-callout="true"]') &&
            this.moveToBlockGap?.(block, backwards ? 'up' : 'down', selection)) { this.refresh(); return true; }
        return false;
    }

    normalizeCaret(selection = this.selection) {
        if (this.isComposing() || !selection?.rangeCount || !selection.isCollapsed) return false;
        const range = selection.getRangeAt(0), node = range.startContainer;
        const container = elementOf(node), block = this.getTypeBlock(node);
        if (!block) return false;
        const content = Array.from(block.children).find(child => child.classList.contains('mdw-callout-content'));
        if (!content) return false;
        if (container === block) {
            const index = Array.prototype.indexOf.call(block.childNodes, content);
            const offset = node === block ? range.startOffset : Array.prototype.indexOf.call(block.childNodes, node);
            return offset <= index ? this.moveToBody(block, selection)
                : this.moveToBlockBoundary(this.navigableSibling(content.lastChild, true), selection, 'backward');
        }
        if (container?.closest('.mdw-callout-title[contenteditable="false"]')) return this.moveToBody(block, selection);
        if (container !== content || (node.nodeType === 3 && node.textContent.trim() !== '')) return false;
        const previous = this.navigableSibling(node.nodeType === 3 ? node.previousSibling : content.childNodes[range.startOffset - 1], true);
        const next = this.navigableSibling(node.nodeType === 3 ? node.nextSibling : content.childNodes[range.startOffset]);
        return next ? this.moveToBlockBoundary(next, selection, 'forward')
            : this.moveToBlockBoundary(previous, selection, 'backward');
    }

    handleTypeNavigation(selection, direction) {
        if (this.isComposing() || this.typePicker || !selection) return false;
        const backwards = direction === 'up' || direction === 'backward' || direction === 'left';
        const vertical = direction === 'up' || direction === 'down';
        const formatButton = this.getFocusedFormatButton();
        if (formatButton) {
            if (!backwards) return this.moveToBody(formatButton.parentElement, selection, direction);
            if (!this.selectTypeLabel(formatButton, selection)) return false;
            if (!vertical) return true;
        }
        if (!selection.rangeCount) return false;
        const selected = this.getSelectedTypeLabel(selection);
        if (selected) {
            if (!backwards && !vertical) return this.focusFormatButton(selected, selection);
            if (!backwards) return this.moveToBody(selected.parentElement, selection, direction);
            if (this.moveToBlockGap?.(selected.parentElement, 'up', selection, true)) {
                this.refresh(); return true;
            }
            let current = selected.parentElement;
            while (current && current !== this.editor) {
                const previous = this.navigableSibling(current.previousSibling, true);
                if (previous) return this.moveToBlockBoundary(previous, selection, direction);
                current = current.parentElement;
                if (current?.classList.contains('mdw-callout-content')) return this.selectTypeLabel(current.parentElement, selection);
            }
            return true;
        }
        const range = selection.getRangeAt(0);
        // A selected code language label is a separate row above its code.
        // From the first code block in a callout, its upward neighbor is the type.
        if (!range.collapsed && backwards && range.startContainer === range.endContainer && range.endOffset === range.startOffset + 1) {
            const label = range.startContainer.childNodes[range.startOffset];
            const pre = elementOf(label)?.closest('pre');
            const content = this.getContent(pre);
            if (label?.classList?.contains('code-block-language') && pre && content) {
                const edge = this.document.createRange(); edge.setStartBefore(pre); edge.collapse(true);
                if (this.atEdge(edge, content, false)) return this.selectTypeLabel(content.parentElement, selection);
            }
        }
        const element = elementOf(range.startContainer);
        if (!range.collapsed || !this.editor.contains(range.startContainer) ||
            element?.closest('[contenteditable="false"]')) return false;
        // TableManager keeps movement inside the table until its row boundary.
        if (vertical && element?.closest('table, .md-table-wrapper')) return false;
        // Chromium can put a caret on a DIV boundary or parser whitespace after
        // a padding click/native arrow. Those are not visual text lines; handing
        // them to generic vertical hit-testing can skip the body or leave the editor.
        if (this.handleBoundaryNavigation(selection, direction)) return true;
        const inlineCode = !vertical && element?.closest('code');
        if (inlineCode && !inlineCode.closest('pre')) return false;
        const content = this.getContent(range.startContainer);
        if (backwards && content && this.isVisualEdge(range, content, false, vertical)) return this.selectTypeLabel(content.parentElement, selection);
        let current = element?.closest('p, li, pre, h1, h2, h3, h4, h5, h6') || element;
        if (!current) return false;
        if (backwards) {
            // An empty line below a callout belongs to the outer document. Enter
            // the callout's last body line before code/table navigation treats it
            // as an empty line above the next block.
            if (!vertical || !this.cursorManager?._isEffectivelyEmptyBlock(current)) return false;
            const previous = this.getBoundaryCallout(this.navigableSibling(current.previousSibling, true), true);
            return !!previous && this.moveToBlockBoundary(previous, selection, 'up');
        }
        if (current.tagName === 'PRE') {
            const code = current.querySelector('code');
            const offset = code && this.cursorManager?.getCodeBlockCursorOffset(code, range);
            if (!code || offset === null || offset === undefined) return false;
            const text = this.cursorManager.getCodeBlockText(code);
            const end = text.length - (text.endsWith('\n') ? 1 : 0);
            if (vertical ? text.slice(offset, end).includes('\n') : offset < end) return false;
        } else if (!this.isVisualEdge(range, current, true, vertical)) return false;
        while (current && current !== this.editor) {
            if (current.matches('[data-mdw-callout="true"]') && this.moveToBlockGap?.(current, 'down', selection)) {
                this.refresh(); return true;
            }
            const next = this.navigableSibling(current.nextSibling);
            if (next) {
                const incoming = this.getBoundaryCallout(next);
                // The code-block exit normally owns this boundary. Type-label
                // navigation runs first, so preserve its intermediate input line.
                if (incoming && current.tagName === 'PRE' && this.moveToBlockGap?.(current, 'down', selection)) {
                    this.refresh(); return true;
                }
                if (content && vertical && element.closest('pre') &&
                    next.nodeType === 1 && next.matches('table, .md-table-wrapper')) {
                    return this.moveToBlockBoundary(next, selection, direction);
                }
                if (content && !vertical && !incoming) return this.moveToBlockBoundary(next, selection, direction);
                return incoming ? this.selectTypeLabel(incoming, selection) : false;
            }
            current = current.parentElement;
        }
        return false;
    }

    getContent(node) {
        const content = elementOf(node)?.closest('.mdw-callout-content');
        return content && this.editor.contains(content) && content.parentElement?.matches('[data-mdw-callout="true"]')
            ? content : null;
    }

    editingRoot(node) {
        const content = elementOf(node)?.closest('.mdw-callout-content, .mdw-footnote-content');
        return content && this.editor.contains(content) ? content : this.editor;
    }

    canRecognize(range = this.getRange()) {
        return !this.isComposing() && range?.collapsed && this.editor.contains(range.startContainer) &&
            !this.getTypeBlock(range.startContainer) &&
            !elementOf(range.startContainer)?.closest('pre, code, [contenteditable="false"], td, th');
    }

    plainLine(node) {
        if (!node || !/^(P|DIV)$/.test(node.tagName) ||
            Array.from(node.childNodes).some(child => child.nodeType !== 3)) return null;
        return node.textContent;
    }

    createEmptyBlock(service = 'github') {
        const dialect = resolveCalloutService(service);
        const initial = quoteHeader('> [!NOTE]');
        const spec = dialect === 'github' ? initial : dialectDeclaration(typeDescriptor(initial.header, initial.format), dialect);
        const block = this.createBlock({ ...spec, title: spec.type });
        block.lastElementChild.appendChild(this.emptyParagraph());
        return block;
    }

    createBlock(spec) {
        const block = this.document.createElement('div');
        block.className = 'mdw-callout';
        block.setAttribute('data-mdw-callout', 'true');
        for (const name of ['header', 'footer']) block.setAttribute('data-mdw-callout-' + name, encode(spec[name] || '', this.document.defaultView));
        for (const name of ['format', 'type', 'variant']) block.setAttribute('data-mdw-callout-' + name, spec[name]);
        const title = this.document.createElement('div');
        title.className = 'mdw-callout-title';
        title.setAttribute('contenteditable', 'false');
        title.setAttribute('role', 'button'); title.setAttribute('tabindex', '-1');
        title.setAttribute('aria-haspopup', 'listbox'); title.setAttribute('aria-expanded', 'false');
        title.setAttribute('aria-label', `Change callout type (${spec.type})`);
        title.textContent = spec.title;
        const content = this.document.createElement('div');
        content.className = 'mdw-callout-content';
        block.appendChild(title);
        block.appendChild(content);
        return block;
    }

    emptyParagraph() {
        const paragraph = this.document.createElement('p');
        paragraph.appendChild(this.document.createElement('br'));
        return paragraph;
    }

    placeCaret(node, atEnd = false) {
        const range = this.document.createRange();
        range.selectNodeContents(node);
        range.collapse(!atEnd);
        this.selection.removeAllRanges();
        this.selection.addRange(range);
    }

    finishChange(options) { this.onChange(options); }

    /** Quote lines are already isolated by the existing Markdown paste parser. */
    createPastedQuoteCallouts(lines, appendInline) {
        const groups = [[]];
        for (const raw of lines) {
            if (!raw.trim()) {
                if (groups[groups.length - 1].length) groups.push([]);
            } else {
                const match = /^ {0,3}>[ \t]?(.*)$/.exec(raw);
                if (!match) return null;
                groups[groups.length - 1].push({ raw, text: match[1] });
            }
        }
        if (this.getTypeBlock(this.getRange()?.startContainer)) return null;
        const declarations = groups.map(group => /^\[!/.test(group[0]?.text || '') ? quoteHeader(group[0].raw) : null);
        if (!declarations.some(Boolean)) return null;
        const fragment = this.document.createDocumentFragment();
        groups.forEach((group, index) => {
            if (!group.length) return;
            const spec = declarations[index];
            const block = spec ? this.createBlock(spec) : this.document.createElement('blockquote');
            const content = spec ? block.lastElementChild : block;
            let paragraph = null;
            for (const { text: line } of spec ? group.slice(1) : group) {
                if (!line.trim()) { paragraph = null; continue; }
                if (!paragraph) {
                    paragraph = this.document.createElement('p');
                    content.appendChild(paragraph);
                } else paragraph.appendChild(this.document.createElement('br'));
                appendInline(paragraph, line);
            }
            if (!content.firstElementChild) content.appendChild(this.emptyParagraph());
            fragment.appendChild(block);
        });
        return fragment;
    }

    convertQuote() {
        const range = this.getRange();
        if (!this.canRecognize(range)) return false;
        const paragraph = elementOf(range.startContainer)?.closest('p');
        const quote = paragraph?.parentElement;
        const quoted = quote?.tagName === 'BLOCKQUOTE' && paragraph === quote.firstElementChild;
        if (!paragraph || (!quoted && paragraph.parentElement !== this.editingRoot(paragraph))) return false;
        const line = this.plainLine(paragraph);
        if (line === null || (!quoted && !/^ {0,3}>/.test(line)) || !this.atEdge(range, paragraph, true)) return false;
        const spec = quoteHeader(line);
        if (!spec) return false;
        if (quote?.querySelector('[data-mdw-callout="true"]')) return false;
        const block = this.createBlock(spec), content = block.lastElementChild;
        this.beforeChange();
        const original = quoted ? quote : paragraph;
        original.parentNode.insertBefore(block, original);
        if (quoted) {
            paragraph.remove();
            while (quote.firstChild) content.appendChild(quote.firstChild);
        }
        original.remove();
        if (!content.firstElementChild) content.appendChild(this.emptyParagraph());
        this.placeCaret(content.firstElementChild);
        this.finishChange();
        return true;
    }

    convertContainer() {
        const range = this.getRange();
        if (!this.canRecognize(range)) return false;
        const closing = elementOf(range.startContainer)?.closest('p, div');
        const footer = this.plainLine(closing);
        const hint = footer && gitbookCloser.test(footer);
        if (!footer || (!hint && !/^ {0,3}:{3,}[ \t]*$/.test(footer)) ||
            closing.parentElement !== this.editingRoot(closing) || !this.atEdge(range, closing, true)) return false;
        const nodes = [];
        let opening = closing.previousSibling, spec = null;
        for (; opening; opening = opening.previousSibling) {
            const line = this.plainLine(opening);
            // An intervening delimiter (including an unknown one) is ambiguous.
            if (line !== null && (hint ? /^ {0,3}\{%[ \t]+(?:end)?hint\b/.test(line) : /^ {0,3}:::/.test(line))) {
                spec = fencedBlockSpec(line, footer) || (!hint && containerHeader(line));
                break;
            }
            nodes.unshift(opening);
        }
        if (!spec || (spec.format === 'container' && footer.trim().length < spec.fence.length)) return false;
        if (spec.format === 'myst' && mystHasOptions(nodes.map(node => node.textContent).join('\n'))) return false;
        // A delimiter nested in a block, or a fenced example typed as prose,
        // needs the full parser rather than this local DOM shortcut.
        if (nodes.some(node => node.nodeType === 1 &&
            ((/^(P|DIV)$/.test(node.tagName) && /(?:^|\n) {0,3}(?::::|\{%[ \t]+(?:end)?hint\b|`{3,}|~{3,})/.test(node.textContent)) ||
                node.matches('[data-mdw-callout]') || node.querySelector('[data-mdw-callout]')))) return false;
        spec.footer = footer;
        const block = this.createBlock(spec), content = block.lastElementChild;
        this.beforeChange();
        opening.parentNode.insertBefore(block, opening);
        nodes.forEach(node => content.appendChild(node));
        opening.remove(); closing.remove();
        if (!content.firstElementChild) content.appendChild(this.emptyParagraph());
        this.placeCaret(content.lastElementChild, true);
        this.finishChange();
        return true;
    }

    convertMkdocs() {
        const range = this.getRange();
        if (!this.canRecognize(range)) return false;
        const last = elementOf(range.startContainer)?.closest('p');
        if (!last || last.parentElement !== this.editingRoot(last) || !this.atEdge(range, last, true)) return false;
        const body = [];
        let opening = last;
        for (; opening; opening = opening.previousElementSibling) {
            if (opening.tagName !== 'P' || opening.firstChild?.nodeType !== 3 ||
                !/^(?: {4}|\t)/.test(opening.firstChild.textContent)) break;
            body.unshift(opening);
        }
        const line = this.plainLine(opening);
        const match = line && /^( {0,3})(!!!|\?\?\?\+?)[ \t]+([a-z]+)(?:[ \t]+"([^"\r\n]*)")?[ \t]*$/.exec(line);
        if (!body.length || !match || !variants[match[3]]) return false;
        const indentWidth = match[1].length + 4;
        if (body.some(node => !node.firstChild.textContent.startsWith(' '.repeat(indentWidth)) &&
            !node.firstChild.textContent.startsWith('\t'))) return false;
        const spec = { header: line, footer: '', format: 'mkdocs', type: match[3],
            variant: variants[match[3]], title: match[4] ?? match[3] };
        const block = this.createBlock(spec), content = block.lastElementChild;
        this.beforeChange();
        opening.parentNode.insertBefore(block, opening);
        body.forEach(node => {
            node.firstChild.deleteData(0, node.firstChild.textContent.startsWith('\t') ? 1 : indentWidth);
            content.appendChild(node);
        });
        opening.remove();
        const paragraph = this.emptyParagraph();
        content.appendChild(paragraph);
        this.placeCaret(paragraph);
        this.finishChange();
        return true;
    }

    /** Compare DOM boundaries without flattening or replacing editable text. */
    atEdge(range, root, atEnd) {
        if (!range?.collapsed || !root.contains(range.startContainer)) return false;
        const meaningful = node => {
            if (node.nodeType === 3) return !/^[\r\n\u200B\u2060\uFEFF]*$/.test(node.textContent);
            // Chromium keeps a terminal BR as a placeholder. A BR before
            // another line separates two distinct editable positions.
            return node.nodeType === 1 && (node.tagName !== 'BR' || !!this.navigableSibling(node.nextSibling));
        };
        let node = range.startContainer;
        if (node.nodeType === 3) {
            const text = atEnd ? node.textContent.slice(range.startOffset) : node.textContent.slice(0, range.startOffset);
            if (!/^[\u200B\u2060\uFEFF]*$/.test(text)) return false;
        } else {
            const nodes = Array.from(node.childNodes);
            if ((atEnd ? nodes.slice(range.startOffset) : nodes.slice(0, range.startOffset)).some(meaningful)) return false;
        }
        while (node !== root) {
            for (let sibling = atEnd ? node.nextSibling : node.previousSibling; sibling;
                sibling = atEnd ? sibling.nextSibling : sibling.previousSibling) {
                if (meaningful(sibling)) return false;
            }
            node = node.parentNode;
            if (!node) return false;
        }
        return true;
    }

    protectBoundary(event, backwards) {
        const range = this.getRange();
        const content = this.getContent(range?.startContainer);
        if (!range?.collapsed) return false;
        if (content && this.atEdge(range, content, !backwards)) {
            event.preventDefault();
            return true;
        }
        return false;
    }

    deleteEmptyBlock() {
        const range = this.getRange();
        const title = this.getSelectedTypeLabel();
        const block = title?.parentElement || (range?.collapsed && this.getContent(range.startContainer)?.parentElement);
        const content = block && Array.from(block.children).find(child => child.classList.contains('mdw-callout-content'));
        if (!content || !this.deleteBlock ||
            content.textContent.replace(/[\u200B\u2060\uFEFF]/g, '').trim() !== '' ||
            content.querySelector('img, input, code, pre, hr, table, ul, ol, blockquote, [data-mdw-callout], [data-mdw-math], [contenteditable="false"]')) return false;
        this.beforeChange();
        this.deleteBlock(block, this.selection);
        this.refresh();
        this.finishChange({ preferLiveSelection: true });
        return true;
    }

    handleDeletion(event, backwards) {
        if (this.deleteEmptyBlock() || this.getSelectedTypeLabel() || this.protectBoundary(event, backwards)) {
            event.preventDefault(); return true;
        }
        if (this.normalizeCaret()) {
            this.deleteEmptyBlock();
            event.preventDefault(); return true;
        }
        return false;
    }

    exitEmptyParagraph() {
        const range = this.getRange();
        const content = this.getContent(range?.startContainer);
        const paragraph = elementOf(range?.startContainer)?.closest('p');
        if (!range?.collapsed || !content || paragraph?.parentElement !== content ||
            paragraph !== content.lastElementChild || paragraph.textContent !== '' ||
            paragraph.querySelector('img, input, code, pre, hr, table')) return false;
        this.beforeChange();
        const block = content.parentElement, outside = this.emptyParagraph();
        block.parentNode.insertBefore(outside, block.nextSibling);
        if (content.children.length > 1) paragraph.remove();
        this.placeCaret(outside);
        this.finishChange();
        return true;
    }

    handleKeydown(event, isMac = false) {
        if (this.isComposing() || event.isComposing || event.keyCode === 229 || event.which === 229) return false;
        if (this.typePicker) {
            this.pickerKeydown?.(event);
            return !!event.defaultPrevented;
        }
        const title = this.getSelectedTypeLabel();
        const ctrlH = isMac && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key?.toLowerCase() === 'h';
        const deletion = ctrlH || (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey &&
            (event.key === 'Backspace' || event.key === 'Delete'));
        if (deletion) return this.handleDeletion(event, event.key !== 'Delete');
        const navigation = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'backward', ArrowRight: 'forward' };
        const macNavigation = { p: 'up', n: 'down', b: 'backward', f: 'forward' };
        const direction = !event.shiftKey && !event.altKey && !event.metaKey &&
            (!event.ctrlKey ? navigation[event.key] : isMac ? macNavigation[event.key?.toLowerCase()] : null);
        if (direction && this.handleTypeNavigation(this.selection, direction)) {
            event.preventDefault(); event.stopPropagation?.(); return true;
        }
        if (title && (event.ctrlKey || event.metaKey) && !event.altKey &&
            ['b', 'i', 'u', 'k'].includes(event.key?.toLowerCase())) {
            event.preventDefault(); return true;
        }
        if (title && event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault();
            const moved = event.shiftKey ? this.handleTypeNavigation(this.selection, 'backward') : this.focusFormatButton(title);
            if (moved) this.onNavigate();
            return moved;
        }
        if (title && !event.ctrlKey && !event.metaKey && !event.altKey) {
            if (event.key === 'Enter' || event.key === ' ' || event.key?.length === 1) {
                event.preventDefault(); this.openTypePicker(title); return true;
            }
            if (event.key === 'Escape') {
                event.preventDefault(); this.moveToBody(title.parentElement, this.selection); return true;
            }
        }
        if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false;
        if (event.key === 'Enter' && (this.convertQuote() || this.convertContainer() ||
            this.convertMkdocs() || this.exitEmptyParagraph())) {
            event.preventDefault();
            return true;
        }
        return false;
    }

    handleBeforeInput(event) {
        if (this.isComposing() || event.isComposing || event.inputType === 'insertCompositionText') return false;
        if (event.inputType === 'deleteContentBackward' || event.inputType === 'deleteContentForward') {
            return this.handleDeletion(event, event.inputType === 'deleteContentBackward');
        }
        this.normalizeCaret();
        if (this.getSelectedTypeLabel() && /^(?:insert|delete|format)/.test(event.inputType || '')) {
            event.preventDefault();
            if (event.inputType.startsWith('insert')) this.openTypePicker(this.getSelectedTypeLabel());
            return true;
        }
        if (event.inputType === 'insertParagraph') return this.handleKeydown({ key: 'Enter', preventDefault: () => event.preventDefault() });
        return false;
    }

    handleInput(event = {}) {
        if (this.isComposing() || event.isComposing || event.inputType === 'insertCompositionText') return false;
        // Only a newly completed closing delimiter triggers the container shortcut.
        if (event.inputType === 'insertText' && (event.data === ':' || event.data === '}')) return this.convertContainer();
        return false;
    }

    prepareClipboardImport(html, trusted) {
        if (!html.includes('data-mdw-callout')) return { html, blocks: [] };
        const template = this.document.createElement('template');
        template.innerHTML = html;
        const blocks = [];
        for (const block of Array.from(template.content.querySelectorAll('[data-mdw-callout="true"]')).reverse()) {
            // Only the outer callout retains metadata. Nested visible content
            // passes through the ordinary clipboard sanitizer as prose.
            if (block.parentElement?.closest('[data-mdw-callout="true"]')) continue;
            const content = Array.from(block.children).find(node => node.classList.contains('mdw-callout-content'));
            if (!content) continue;
            // Live/history HTML can include the generated format control.
            // Strip only its exact UI shape; other extra content still falls back.
            Array.from(block.children).filter(node => node.tagName === 'BUTTON' &&
                node.classList.contains('mdw-callout-format-toggle') && node.getAttribute('contenteditable') === 'false' &&
                node.getAttribute('data-exclude-from-markdown') === 'true' && ['', '…'].includes(node.textContent) && !node.children.length)
                .forEach(node => node.remove());
            const titleNode = Array.from(block.children).find(node => node.classList.contains('mdw-callout-title'));
            let spec;
            if (!trusted) {
                spec = clipboardCalloutSpec(
                    decode(block.getAttribute('data-mdw-callout-header'), this.document.defaultView),
                    decode(block.getAttribute('data-mdw-callout-footer'), this.document.defaultView),
                    block.getAttribute('data-mdw-callout-format')
                );
                // Accept only a complete visible callout. Extra nodes and a
                // mismatched title must not disappear behind private metadata.
                if (!spec || !titleNode || titleNode.textContent !== spec.title ||
                    Array.from(titleNode.childNodes).some(node => node.nodeType !== 3) ||
                    Array.from(block.childNodes).some(node => node.nodeType === 3 ? node.textContent.trim() !== ''
                        : node.nodeType === 1 && node !== titleNode && node !== content)) continue;
            }
            const placeholder = this.document.createElement('div');
            let id = `mdw-callout-copy-${Date.now()}-${blocks.length}`;
            while (template.content.querySelector(`[id="${id}"]`)) id += '-x';
            placeholder.id = id;
            while (content.firstChild) placeholder.appendChild(content.firstChild);
            const metadata = trusted
                ? Object.fromEntries(metadataNames.map(name => [name, block.getAttribute('data-mdw-callout-' + name)]))
                : { source: null, header: encode(spec.header, this.document.defaultView), footer: encode(spec.footer, this.document.defaultView),
                    format: spec.format, type: spec.type, variant: spec.variant };
            const title = spec?.title ?? titleNode?.textContent ?? '';
            blocks.push({ id, metadata, title });
            block.replaceWith(placeholder);
        }
        return { html: template.innerHTML, blocks };
    }

    restoreClipboardImport(container, prepared) {
        for (const { id, metadata, title } of prepared.blocks) {
            const placeholder = container.querySelector(`[id="${id}"]`);
            if (!placeholder) continue;
            const block = this.createBlock({ ...metadata, title, header: '', footer: '' });
            for (const name of metadataNames) {
                if (metadata[name] !== null) block.setAttribute('data-mdw-callout-' + name, metadata[name]);
            }
            while (placeholder.firstChild) block.lastElementChild.appendChild(placeholder.firstChild);
            placeholder.replaceWith(block);
        }
    }
}
