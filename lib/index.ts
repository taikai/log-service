import 'winston-daily-rotate-file';

import { ConsoleConfig, FileConfig, InitialConfig, LogLevel, LogServiceChainExtensions } from '@types';
import ElasticSearch from '@utils/elastic-search';
import sanitize from '@utils/sanitizers';
import path from 'path';
import process from 'process';
import { createLogger, format, Logger, transports } from 'winston';

const { combine, timestamp, label, printf, prettyPrint } = format;

/**
 *
 */
class LogService {
  private loggers: Logger[];
  private blackListParams: string[];
  private globalConfig: InitialConfig;
  private mask: string;

  /**
   *
   * @param _blackListParams A list of keys which value should be masked on the logs
   * @param _mask The custom mask to be used when
   */
  constructor(_blackListParams?: string[], _mask?: string) {
    this.loggers = [];
    this.blackListParams = _blackListParams ?? [];
    this.mask = _mask ?? '*';
  }

  getBlackListParams() {
    return this.blackListParams;
  }

  setBlackListParams(_blackListParams: string[]) {
    this.blackListParams = _blackListParams;
  }

  addToBlackList(newBlackListParam: string[]) {
    this.blackListParams.push(...newBlackListParam);
  }

  removeFromBlackList(_blackListParam: string) {
    this.blackListParams = this.blackListParams.filter((param) => param !== _blackListParam);
  }

  init(config: InitialConfig) {
    this.globalConfig = config;
    this.addFileLoggers(config.file);
    this.addConsoleLogger(config.console);
  }

  private simplifyPrint() {
    return printf((info) => {
      const {
        timestamp: timestampInfo,
        label: labelInfo,
        level: levelInfo,
        message: messageInfo,
        ...restOfInfo
      } = info;
      return `${timestampInfo} [${labelInfo.toString().padStart(5, ' ')}] ${levelInfo}: ${
        Object.keys(restOfInfo).length
          ? JSON.stringify({ message: messageInfo, ...restOfInfo })
          : typeof messageInfo === 'string'
            ? messageInfo
            : JSON.stringify(messageInfo)
        }`;
    });
  }

  private addConsoleLogger(consoleConfig: ConsoleConfig) {
    if (!consoleConfig?.silent) {
      const myFormat = combine(
        label({ label: process.pid.toString() }),
        timestamp(),
        consoleConfig.prettify ? prettyPrint({ colorize: true, depth: 4 }) : this.simplifyPrint()
      );
      const consoleLogger = createLogger({
        level: consoleConfig.logLevel ?? LogLevel.debug,
        format: myFormat,
        transports: [new transports.Console()],
        silent: consoleConfig.silent,
      });
      this.loggers.push(consoleLogger);
    }
  }

  private addFileLoggers(fileConfig: FileConfig) {
    if (fileConfig && !fileConfig.silent) {
      const simpleFormatter = format((info, opts) => ({
        ...info,
        pid: process.pid,
        hostname: this.globalConfig.hostname,
        application: this.globalConfig.appName,
        version: this.globalConfig.version,
      }));

      const myFormat = combine(simpleFormatter(), timestamp(), format.json());
      if (fileConfig.logDailyRotation) {
        const transport = new transports.DailyRotateFile({
          filename: `${this.globalConfig.appName}-%DATE%.log`,
          dirname: fileConfig.logFileDir ?? './logs/',
          datePattern: fileConfig.logDailyRotationOptions?.datePattern ?? 'YYYY-MM-DD',
          zippedArchive: fileConfig.logDailyRotationOptions?.zippedArchive ?? true,
          maxSize: fileConfig.logDailyRotationOptions?.maxSize ?? '20m',
          maxFiles: fileConfig.logDailyRotationOptions?.maxFiles,
        });

        const fileLogger = createLogger({
          level: fileConfig.logLevel ?? LogLevel.debug,
          format: myFormat,
          transports: [transport],
          silent: fileConfig.silent,
        });

        this.loggers.push(fileLogger);
      } else {
        const logPath = path.join(
          fileConfig.logFileDir ?? './logs/',
          `${this.globalConfig.appName}.log`
        );
        const fileLogger = createLogger({
          level: fileConfig.logLevel ?? LogLevel.debug,
          format: myFormat,
          transports: [new transports.File({ filename: logPath })],
          silent: fileConfig.silent,
        });
        this.loggers.push(fileLogger);
      }
    }
  }

  /**
   * Change the level of logs
   */
  setLevel(level: LogLevel) {
    this.loggers.forEach((logger) => {
      logger.level = level;
    });
  }

  /**
   * Log a content on debug level
   * @param contents all the contents you intend to log in console/file, each content can be of any type of data
   */
  d(...contents: any[]): LogServiceChainExtensions {
    contents.forEach((content) => {
      this.log(LogLevel.debug, content);
    });

    return {
      send() {
        contents.forEach((content) => {
          this.sendLog(LogLevel.debug, content, true)
        });  
      }
    }
  }

  /**
   * Log a content on info level
   * @param contents all the contents you intend to log in console/file, each content can be of any type of data
   */
  i(...contents: any[]): LogServiceChainExtensions {
    contents.forEach((content) => {
      this.log(LogLevel.info, content);
    });

    return {
      send() {
        contents.forEach((content) => {
          this.sendLog(LogLevel.info, content, true)
        });
      }
    }
  }

  /**
   * Log a content on warning level
   * @param contents all the contents you intend to log in console/file, each content can be of any type of data
   */
  w(...contents: any[]): LogServiceChainExtensions {
    contents.forEach((content) => {
      this.log(LogLevel.warning, content);
    });
    
    return {
      send() {
        contents.forEach((content) => {
          this.sendLog(LogLevel.warning, content, true)
        });  
      }
    }
  }

  /**
   * Log a content on error level
   * @param contents all the contents you intend to log in console/file, each content can be of any type of data
   */
  e(...contents: any[]): LogServiceChainExtensions {
    contents.forEach((content) => {
      this.log(LogLevel.error, content);
    });

    return {
      send() {
        contents.forEach((content) => {
          this.sendLog(LogLevel.error, content, true)
        });  
      }
    }
  }

  private log(level: LogLevel, content: any) {
    const msgSanitized = sanitize(content, this.blackListParams, this.mask);
    this.logToLoggers(level, msgSanitized);
    this.sendLog(level, content);
  }

  private sendLog(level: LogLevel, content: any, force?: boolean) {
    // If elastic search is not configured, end the function here
    if (!this.globalConfig.elasticSearch) return;

    const targets = this.globalConfig.elasticSearch.targets || [];
    // Sending to Elastic Search
    const elastic = new ElasticSearch(this.globalConfig.elasticSearch);

    let message = '';

    switch (typeof content) {
      case 'object':
        message = JSON.stringify(content);
        break;
      case 'undefined':
        message = 'Empty log message';
        break;
      default:
        message = String(content);
        break;
    }

    const send = () => {
      elastic.send({
        index: `${level}-log`,
        message: message,
      });
    }

    // Just send the log
    if (force)
      return send();

    // Send all the logs
    if (targets.includes('*'))
      return send();

    // Send only the 
    if (targets.includes(level))
      send();
  }

  private logToLoggers(level: LogLevel, msg: string) {
    this.loggers.forEach((logger) => {
      if (!logger.silent) {
        logger[level](msg);
      }
    });
  }
}

export * from '@types';
export default LogService;
