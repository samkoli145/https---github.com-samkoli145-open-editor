// src/host/discovery/mime-resolver.ts
import { Result, ok, err } from '../../kernel/core/result';
import { LinuxArchExecutionLayer } from '../../agent-kernel/linux-arch-execution-layer';
import { ProgramCatalog } from './program-catalog';
import { DesktopEntryInfo } from './desktop-entry-scanner';

export interface MimeResolution {
  readonly filePath: string;
  readonly mimeType: string;
  readonly defaultProgram?: DesktopEntryInfo;
  readonly availablePrograms: DesktopEntryInfo[];
}

export class MimeResolver {
  constructor(
    private executionLayer?: LinuxArchExecutionLayer,
    private catalog?: ProgramCatalog
  ) {}

  /**
   * تحديد نوع الملف (MIME) واسترجاع البرامج المرتبطة والافتراضية
   */
  async resolve(filePath: string): Promise<Result<MimeResolution, Error>> {
    try {
      let mimeType = 'application/octet-stream';
      if (this.executionLayer) {
        const check = await this.executionLayer.execute({
          commandLine: `file --mime-type -b "${filePath}" 2>/dev/null`
        });
        if (check.status === 'success' && check.stdout.trim()) {
          mimeType = check.stdout.trim();
        }
      }

      const availablePrograms = this.catalog ? this.catalog.getByMimeType(mimeType) : [];
      const defaultProgram = availablePrograms.length > 0 ? availablePrograms[0] : undefined;

      return ok({
        filePath,
        mimeType,
        defaultProgram,
        availablePrograms
      });
    } catch (error) {
      return err(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * فتح ملف باستعمال برنامج محدد
   */
  async openWith(filePath: string, program: DesktopEntryInfo): Promise<Result<string, Error>> {
    if (!this.executionLayer) {
      return err(new Error('No execution layer available'));
    }

    let execCmd = program.exec;
    if (execCmd.includes('%')) {
      execCmd = execCmd.replace(/%[uUfF]/, `"${filePath}"`).replace(/%[a-zA-Z]/g, '').trim();
    } else {
      execCmd = `${execCmd} "${filePath}"`;
    }

    const result = await this.executionLayer.execute({ commandLine: `${execCmd} &` });
    if (result.status === 'success') {
      return ok(`Opened ${filePath} with ${program.name}`);
    }
    return err(new Error(result.reason || 'Failed to launch program'));
  }

  /**
   * فتح الملف بالنظام الافتراضي (xdg-open)
   */
  async openWithDefault(filePath: string): Promise<Result<string, Error>> {
    if (!this.executionLayer) {
      return err(new Error('No execution layer available'));
    }

    const result = await this.executionLayer.execute({ commandLine: `xdg-open "${filePath}" &` });
    if (result.status === 'success') {
      return ok(`Opened ${filePath} with default application`);
    }
    return err(new Error(result.reason || 'Failed to open file with xdg-open'));
  }
}
