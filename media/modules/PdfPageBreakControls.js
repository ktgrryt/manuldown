/** Controls are placed from the printed PDF's source-block map, never saved coordinates. */
export class PdfPageBreakControls {
    constructor(onChange) {
        this.onChange = onChange;
    }

    render({ pageNodes, boundaries, blocks, breaks, position, enabled, pendingId }) {
        this.clear(pageNodes);
        const targets = new Map(blocks.slice(1).map(block => [block.id, block]));
        const layers = pageNodes.map(holder => {
            const layer = document.createElement('div');
            layer.className = 'break-overlay';
            holder.appendChild(layer);
            return layer;
        });
        const placements = boundaries.filter(boundary => targets.has(boundary.id) && layers[boundary.page - 1] &&
                (!boundary.atPageStart || breaks.has(boundary.id)))
            .map(boundary => ({ boundary, block: targets.get(boundary.id), point: position(boundary), clearance: Infinity }))
            .sort((a, b) => a.boundary.page - b.boundary.page || a.point.top - b.point.top);
        // Keep adjacent hit strips separate even at small zooms.
        const perPage = new Map();
        for (const placement of placements) {
            if (breaks.has(placement.block.id)) continue;
            const number = placement.boundary.page;
            if (!perPage.has(number)) perPage.set(number, []);
            perPage.get(number).push(placement);
        }
        for (const positions of perPage.values()) {
            positions.sort((a, b) => a.point.top - b.point.top);
            positions.forEach((placement, index) => {
                placement.clearance = Math.min(placement.point.top - (positions[index - 1]?.point.top ?? -Infinity),
                    (positions[index + 1]?.point.top ?? Infinity) - placement.point.top);
            });
        }
        for (const { boundary, block, point, clearance } of placements) {
            const layer = layers[boundary.page - 1];
            const manual = breaks.has(block.id);
            const guide = document.createElement('div');
            guide.className = `break-guide${manual ? ' manual-break' : ''}${pendingId === block.id ? ' is-pending' : ''}`;
            guide.dataset.boundaryFocus = block.id;
            guide.dataset.sourceTop = String(point.top);
            guide.tabIndex = -1;
            guide.setAttribute('role', 'group');
            guide.setAttribute('aria-label', `${manual ? 'Page break' : 'Page break position'} before ${block.label}`);
            guide.style.left = `${point.left}px`;
            guide.style.top = `${manual ? -20 : point.top}px`;
            guide.style.width = `${point.width}px`;
            if (!manual) guide.style.height = `${Math.max(2, Math.min(12, clearance - 1))}px`;

            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.boundary = block.id;
            button.disabled = !enabled;
            if (manual) {
                pageNodes[boundary.page - 1].classList.add('has-manual-break');
                const icon = document.createElement('span');
                icon.className = 'md-icon md-icon--undo';
                icon.setAttribute('aria-hidden', 'true');
                const label = document.createElement('span');
                label.textContent = 'Remove page break';
                button.className = 'break-remove';
                button.setAttribute('aria-label', `Remove page break before ${block.label}`);
                button.title = 'Remove this manual page break';
                button.append(icon, label);
                guide.appendChild(button);
            } else {
                button.className = 'break-insert';
                button.setAttribute('aria-label', `Insert page break before ${block.label}`);
                guide.appendChild(button);
            }
            button.addEventListener('click', event => {
                // A second click / held key must not reverse the just-inserted break.
                if (event.detail > 1 || button.disabled) return;
                this.onChange(block.id, !manual);
            });
            button.addEventListener('keydown', event => {
                if (event.repeat && (event.key === 'Enter' || event.key === ' ')) event.preventDefault();
            });
            layer.appendChild(guide);
        }
    }

    clear(pageNodes) {
        for (const holder of pageNodes) {
            holder.querySelector('.break-overlay')?.remove();
            holder.classList.remove('has-manual-break');
        }
    }
}
