export class CompositionUpdateGate {
    constructor() {
        this.generation = 0;
        this.composing = false;
        this.finalizing = false;
        this.pendingMessage = null;
        this.pendingLocalCommit = false;
    }

    begin() {
        this.generation++;
        this.composing = true;
        this.finalizing = false;
        return this.generation;
    }

    end(options = {}) {
        if (options.localChange === true) {
            // A new composition can invalidate the current timer. Keep this
            // cumulative until a later valid generation commits the DOM.
            this.pendingLocalCommit = true;
        }
        this.composing = false;
        this.finalizing = true;
        return this.generation;
    }

    isCurrentFinalization(token) {
        return (
            Number.isInteger(token) &&
            token === this.generation &&
            !this.composing &&
            this.finalizing
        );
    }

    defer(message) {
        if (
            !message ||
            message.external !== true ||
            (message.type !== 'update' && message.type !== 'refresh') ||
            (!this.composing && !this.finalizing)
        ) {
            return false;
        }

        const current = this.pendingMessage;
        const currentId = Number.isFinite(current?.changeId)
            ? Math.floor(current.changeId)
            : Number.NEGATIVE_INFINITY;
        const nextId = Number.isFinite(message.changeId)
            ? Math.floor(message.changeId)
            : Number.NEGATIVE_INFINITY;
        const currentPriority = current?.type === 'refresh' ? 1 : 0;
        const nextPriority = message.type === 'refresh' ? 1 : 0;

        if (
            !current ||
            nextId > currentId ||
            (nextId === currentId && nextPriority >= currentPriority)
        ) {
            this.pendingMessage = { ...message };
        }
        return true;
    }

    shouldCommitLocalChange(token) {
        return this.isCurrentFinalization(token) && this.pendingLocalCommit;
    }

    finish(token) {
        if (!this.isCurrentFinalization(token)) {
            return null;
        }
        this.finalizing = false;
        this.pendingLocalCommit = false;
        const message = this.pendingMessage;
        this.pendingMessage = null;
        return message;
    }

    reset() {
        this.generation++;
        this.composing = false;
        this.finalizing = false;
        this.pendingMessage = null;
        this.pendingLocalCommit = false;
    }
}
