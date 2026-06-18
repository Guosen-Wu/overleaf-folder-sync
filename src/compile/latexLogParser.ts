const LOG_WRAP_LIMIT = 79;
const LATEX_WARNING_REGEX = /^LaTeX(?:3| Font)? Warning: (.*)$/;
const HBOX_WARNING_REGEX = /^(Over|Under)full \\(v|h)box/;
const PACKAGE_WARNING_REGEX = /^((?:Package|Class|Module) \b.+\b Warning:.*)$/;
const LINES_REGEX = /lines? ([0-9]+)/;
const PACKAGE_REGEX = /^(?:Package|Class|Module) (\b.+\b) Warning/;
const FILE_LINE_ERROR_REGEX = /^([./].*):(\d+): (.*)/;

const STATE = {
  normal: 0,
  error: 1,
} as const;

export interface CompileLogEntry {
  line: number | null;
  file: string;
  level: "error" | "warning" | "information";
  message: string;
  content: string;
  raw: string;
}

export interface CompileLogParseResult {
  errors: CompileLogEntry[];
  warnings: CompileLogEntry[];
  information: CompileLogEntry[];
  all: CompileLogEntry[];
  files: unknown[];
}

export class LatexLogParser {
  private state: number = STATE.normal;
  private readonly data: CompileLogEntry[] = [];
  private readonly fileStack: Array<{ path: string; files: unknown[] }> = [];
  private currentFileList: unknown[];
  private readonly rootFileList: unknown[];
  private openParens = 0;
  private readonly log: LogText;
  private currentLine = "";
  private currentError!: CompileLogEntry;
  private currentFilePath = "";

  constructor(text: string) {
    this.currentFileList = this.rootFileList = [];
    this.log = new LogText(text);
  }

  parse(): CompileLogParseResult {
    while (true) {
      this.currentLine = this.log.nextLine();
      if (this.log.fileEnd) {
        break;
      }

      if (this.state === STATE.normal) {
        if (this.currentLineIsError()) {
          this.state = STATE.error;
          this.currentError = {
            line: null,
            file: this.currentFilePath,
            level: "error",
            message: this.currentLine.slice(2),
            content: "",
            raw: `${this.currentLine}\n`,
          };
        } else if (this.currentLineIsFileLineError()) {
          this.state = STATE.error;
          this.parseFileLineError();
        } else if (this.currentLineIsRunawayArgument()) {
          this.parseRunawayArgumentError();
        } else if (this.currentLineIsWarning()) {
          this.parseSingleWarningLine(LATEX_WARNING_REGEX);
        } else if (this.currentLineIsHboxWarning()) {
          this.parseHboxLine();
        } else if (this.currentLineIsPackageWarning()) {
          this.parseMultipleWarningLine();
        } else {
          this.parseParensForFilenames();
        }
      }

      if (this.state === STATE.error) {
        this.currentError.content += `${this.log.linesUpToNextMatchingLine(/^l\.[0-9]+/).join("\n")}\n`;
        this.currentError.content += `${this.log.linesUpToNextWhitespaceLine().join("\n")}\n`;
        this.currentError.content += `${this.log.linesUpToNextWhitespaceLine().join("\n")}\n`;
        this.currentError.raw += this.currentError.content;
        const lineNo = this.currentError.raw.match(/l\.([0-9]+)/);
        if (lineNo && this.currentError.line === null) {
          this.currentError.line = parseInt(lineNo[1], 10);
        }
        this.data.push(this.currentError);
        this.state = STATE.normal;
      }
    }

    return this.postProcess(this.data);
  }

  private currentLineIsError(): boolean {
    return (
      this.currentLine[0] === "!" &&
      this.currentLine !== "!  ==> Fatal error occurred, no output PDF file produced!"
    );
  }

  private currentLineIsFileLineError(): boolean {
    return FILE_LINE_ERROR_REGEX.test(this.currentLine);
  }

  private currentLineIsRunawayArgument(): RegExpMatchArray | null {
    return this.currentLine.match(/^Runaway argument/);
  }

  private currentLineIsWarning(): boolean {
    return LATEX_WARNING_REGEX.test(this.currentLine);
  }

  private currentLineIsPackageWarning(): boolean {
    return PACKAGE_WARNING_REGEX.test(this.currentLine);
  }

  private currentLineIsHboxWarning(): boolean {
    return HBOX_WARNING_REGEX.test(this.currentLine);
  }

  private parseFileLineError(): void {
    const result = this.currentLine.match(FILE_LINE_ERROR_REGEX);
    if (!result) {
      return;
    }
    this.currentError = {
      line: Number(result[2]),
      file: result[1],
      level: "error",
      message: result[3],
      content: "",
      raw: `${this.currentLine}\n`,
    };
  }

  private parseRunawayArgumentError(): void {
    this.currentError = {
      line: null,
      file: this.currentFilePath,
      level: "error",
      message: this.currentLine,
      content: "",
      raw: `${this.currentLine}\n`,
    };
    this.currentError.content += `${this.log.linesUpToNextWhitespaceLine().join("\n")}\n`;
    this.currentError.content += `${this.log.linesUpToNextWhitespaceLine().join("\n")}\n`;
    this.currentError.raw += this.currentError.content;
    const lineNo = this.currentError.raw.match(/l\.([0-9]+)/);
    if (lineNo) {
      this.currentError.line = parseInt(lineNo[1], 10);
    }
    this.data.push(this.currentError);
  }

  private parseSingleWarningLine(prefixRegex: RegExp): void {
    const warningMatch = this.currentLine.match(prefixRegex);
    if (!warningMatch) {
      return;
    }
    const warning = warningMatch[1];
    const lineMatch = warning.match(LINES_REGEX);
    this.data.push({
      line: lineMatch ? parseInt(lineMatch[1], 10) : null,
      file: this.currentFilePath,
      level: "warning",
      message: warning,
      raw: warning,
      content: "Warning",
    });
  }

  private parseMultipleWarningLine(): void {
    let warningMatch = this.currentLine.match(PACKAGE_WARNING_REGEX);
    if (!warningMatch) {
      return;
    }

    const warningLines = [warningMatch[1]];
    let lineMatch = this.currentLine.match(LINES_REGEX);
    let line = lineMatch ? parseInt(lineMatch[1], 10) : null;
    const packageName = this.currentLine.match(PACKAGE_REGEX)?.[1];
    if (!packageName) {
      return;
    }

    const prefixRegex = new RegExp(`(?:\\(${packageName}\\))*[\\s]*(.*)`, "i");
    while ((this.currentLine = this.log.nextLine())) {
      lineMatch = this.currentLine.match(LINES_REGEX);
      line = lineMatch ? parseInt(lineMatch[1], 10) : line;
      warningMatch = this.currentLine.match(prefixRegex);
      warningLines.push(warningMatch?.[1] ?? "");
    }

    const rawMessage = warningLines.join(" ");
    this.data.push({
      line,
      file: this.currentFilePath,
      level: "warning",
      message: rawMessage,
      raw: rawMessage,
      content: "Warning",
    });
  }

  private parseHboxLine(): void {
    const lineMatch = this.currentLine.match(LINES_REGEX);
    this.data.push({
      line: lineMatch ? parseInt(lineMatch[1], 10) : null,
      file: this.currentFilePath,
      level: "information",
      message: this.currentLine,
      raw: this.currentLine,
      content: "Hbox Warning",
    });
  }

  private parseParensForFilenames(): void {
    const pos = this.currentLine.search(/\(|\)/);
    if (pos === -1) {
      return;
    }

    const token = this.currentLine[pos];
    this.currentLine = this.currentLine.slice(pos + 1);
    if (token === "(") {
      const filePath = this.consumeFilePath();
      if (filePath) {
        this.currentFilePath = filePath;
        const newFile = {
          path: filePath,
          files: [],
        };
        this.fileStack.push(newFile);
        this.currentFileList.push(newFile);
        this.currentFileList = newFile.files;
      } else {
        this.openParens++;
      }
    } else if (this.openParens > 0) {
      this.openParens--;
    } else if (this.fileStack.length > 1) {
      this.fileStack.pop();
      const previousFile = this.fileStack[this.fileStack.length - 1];
      this.currentFilePath = previousFile.path;
      this.currentFileList = previousFile.files;
    }

    this.parseParensForFilenames();
  }

  private consumeFilePath(): string | false {
    if (!this.currentLine.match(/^\/?([^ )]+\/)+/)) {
      return false;
    }

    let endOfFilePath = this.currentLine.search(/ |\)/);
    while (endOfFilePath !== -1 && this.currentLine[endOfFilePath] === " ") {
      const partialPath = this.currentLine.slice(0, endOfFilePath);
      if (/\.\w+$/.test(partialPath)) {
        break;
      }

      const remainingPath = this.currentLine.slice(endOfFilePath + 1);
      if (/^\s*["()[\]]/.test(remainingPath)) {
        break;
      }

      const nextEndOfPath = remainingPath.search(/[ "()[\]]/);
      if (nextEndOfPath === -1) {
        endOfFilePath = -1;
      } else {
        endOfFilePath += nextEndOfPath + 1;
      }
    }

    if (endOfFilePath === -1) {
      const path = this.currentLine;
      this.currentLine = "";
      return path;
    }

    const filePath = this.currentLine.slice(0, endOfFilePath);
    this.currentLine = this.currentLine.slice(endOfFilePath);
    return filePath;
  }

  private postProcess(data: CompileLogEntry[]): CompileLogParseResult {
    const all: CompileLogEntry[] = [];
    const hashes = new Set<string>();
    const byLevel: Record<CompileLogEntry["level"], CompileLogEntry[]> = {
      error: [],
      warning: [],
      information: [],
    };

    for (const item of data) {
      if (hashes.has(item.raw)) {
        continue;
      }
      byLevel[item.level].push(item);
      all.push(item);
      hashes.add(item.raw);
    }

    return {
      errors: byLevel.error,
      warnings: byLevel.warning,
      information: byLevel.information,
      all,
      files: this.rootFileList,
    };
  }
}

class LogText {
  private readonly lines: string[] = [];
  private row = -1;
  fileEnd = false;

  constructor(text: string) {
    const wrappedLines = text.replace(/(\r\n)|\r/g, "\n").split("\n");
    this.lines = [wrappedLines[0] ?? ""];

    for (let index = 1; index < wrappedLines.length; index++) {
      const prevLine = wrappedLines[index - 1];
      const currentLine = wrappedLines[index];
      if (prevLine.length === LOG_WRAP_LIMIT && prevLine.slice(-3) !== "...") {
        this.lines[this.lines.length - 1] += currentLine;
      } else {
        this.lines.push(currentLine);
      }
    }
  }

  nextLine(): string {
    this.row++;
    if (this.row >= this.lines.length) {
      this.fileEnd = true;
      return "";
    }
    this.fileEnd = false;
    return this.lines[this.row];
  }

  linesUpToNextWhitespaceLine(): string[] {
    return this.linesUpToNextMatchingLine(/^ *$/);
  }

  linesUpToNextMatchingLine(match: RegExp): string[] {
    const lines: string[] = [];
    while (true) {
      const nextLine = this.nextLine();
      if (this.fileEnd) {
        break;
      }
      lines.push(nextLine);
      if (nextLine.match(match)) {
        break;
      }
    }
    return lines;
  }
}
