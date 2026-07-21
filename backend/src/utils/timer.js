// src/utils/timer.js
import { performance } from 'perf_hooks';

/**
 * Starts a high-resolution performance timer.
 * @returns {Object} An object containing a stop function that returns elapsed milliseconds.
 */
export const startTimer = () => {
    const startTime = performance.now();

    return {
        stop: () => {
            const endTime = performance.now();
            return Math.round(endTime - startTime);
        }
    };
};