/**
 * Stage Manager - Unified Logger & Diagnostic Hub
 * Provides structured logging across Background Worker and Side Panel
 */

const Logger = (function() {
  const MAX_LOGS = 120;
  let logs = [];

  function formatTime() {
    const d = new Date();
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    const s = String(d.getSeconds()).padStart(2, '0');
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${h}:${m}:${s}.${ms}`;
  }

  function add(level, tag, message, details = null) {
    const entry = {
      id: Date.now() + Math.random().toString(36).substring(2, 6),
      time: formatTime(),
      level, // 'INFO', 'WARN', 'ERROR', 'CAPTURE'
      tag,
      message,
      details: details ? (typeof details === 'object' ? JSON.stringify(details) : String(details)) : null
    };

    logs.push(entry);
    if (logs.length > MAX_LOGS) {
      logs.shift();
    }

    // Colored console output
    const colors = {
      INFO: '#1890ff',
      CAPTURE: '#52c41a',
      WARN: '#faad14',
      ERROR: '#ff4d4f'
    };
    const color = colors[level] || '#999';

    if (details) {
      console.log(`%c[StageManager][${entry.tag}] ${entry.message}`, `color: ${color}; font-weight: bold;`, details);
    } else {
      console.log(`%c[StageManager][${entry.tag}] ${entry.message}`, `color: ${color}; font-weight: bold;`);
    }

    // Notify registered UI listener
    if (typeof self !== 'undefined' && self.__onStageManagerLog) {
      try {
        self.__onStageManagerLog(entry);
      } catch (e) {}
    }
  }

  return {
    info: (tag, msg, details) => add('INFO', tag, msg, details),
    capture: (tag, msg, details) => add('CAPTURE', tag, msg, details),
    warn: (tag, msg, details) => add('WARN', tag, msg, details),
    error: (tag, msg, details) => add('ERROR', tag, msg, details),
    getLogs: () => [...logs],
    clearLogs: () => {
      logs = [];
      if (typeof self !== 'undefined' && self.__onStageManagerLogClear) {
        try {
          self.__onStageManagerLogClear();
        } catch (e) {}
      }
    }
  };
})();

// Global exposure
if (typeof self !== 'undefined') {
  self.Logger = Logger;
  self.getStageManagerLogs = () => Logger.getLogs();
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = Logger;
}
