/**
 * Decides which native keystrokes start a new undo step.
 *
 * A checkpoint before every keystroke made Undo go back one character at a
 * time, and about 100 keystrokes pushed older edits (such as a large
 * deletion) out of the history. Instead, a run of typed characters up to a
 * word boundary, or a run of deletions, becomes one step. Another kind of
 * input, a pause, a non-collapsed selection or break() (caret moves,
 * shortcuts) starts a new step, so "12345" followed by five Backspaces is
 * still two steps and never deduplicates away.
 */
export class TypingUndoGroup {
    /**
     * @param {Object} [options]
     * @param {number} [options.pauseMs] - A longer pause ends the run.
     * @param {Function} [options.now] - Clock, for tests.
     */
    constructor(options = {}) {
        this.pauseMs = Number.isFinite(options.pauseMs) ? options.pauseMs : 500;
        this.now = typeof options.now === 'function' ? options.now : () => Date.now();
        this.current = null;
    }

    /** End the current run; the next keystroke starts a new undo step. */
    break() {
        this.current = null;
    }

    /**
     * @param {Object} input
     * @param {string} input.inputType - The beforeinput event's inputType.
     * @param {string|null} [input.data] - The beforeinput event's data.
     * @param {boolean} input.collapsed - Whether the selection is a caret.
     * @returns {boolean} Whether this edit needs its own history checkpoint.
     */
    shouldCheckpoint({ inputType, data = null, collapsed }) {
        let kind = null;
        if (inputType === 'insertText') {
            kind = 'insert';
        } else if (inputType === 'deleteContentBackward' || inputType === 'deleteContentForward') {
            kind = 'delete';
        }
        const time = this.now();
        const continuesRun = !!(
            kind &&
            collapsed &&
            this.current &&
            this.current.kind === kind &&
            !this.current.endsWord &&
            time - this.current.time <= this.pauseMs
        );
        this.current = kind && collapsed
            ? { kind, time, endsWord: kind === 'insert' && /\s/.test(data || '') }
            : null;
        return !continuesRun;
    }
}
