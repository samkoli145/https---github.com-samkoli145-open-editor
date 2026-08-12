import { Result, ok, err } from '../../kernel/core/result';
import { LinuxArchExecutionLayer } from '../../agent-kernel/linux-arch-execution-layer';
import { EmbedResult, EmbedStrategy, DisplayServer, WindowGeometry } from './types';

export class WindowEmbedder {
  private displayServer: DisplayServer;
  private embeddedWindows = new Map<string, { windowId: string; containerId: string }>();

  constructor(
    private executionLayer: LinuxArchExecutionLayer
  ) {
    this.displayServer = this.detectDisplayServer();
  }

  /**
   * تضمين نافذة داخل حاويتنا
   * هذا يعمل على X11 بشكل أفضل من Wayland
   */
  async embedWindow(
    windowId: string,
    containerId: string,
    strategy: EmbedStrategy = 'reparent'
  ): Promise<Result<EmbedResult, Error>> {
    if (this.displayServer === 'x11') {
      return this.embedX11(windowId, containerId, strategy);
    } else {
      return this.embedWayland(windowId, containerId, strategy);
    }
  }

  /**
   * تضمين على X11 باستخدام XEmbed أو Reparenting
   */
  private async embedX11(
    windowId: string,
    containerId: string,
    strategy: EmbedStrategy
  ): Promise<Result<EmbedResult, Error>> {
    const reparentCommand = `
      CONTAINER_WID=$(xdotool search --name "${containerId}" | head -1)
      if [ -n "$CONTAINER_WID" ]; then
        xdotool windowreparent ${windowId} $CONTAINER_WID
      else
        xdotool windowmove ${windowId} 0 0
      fi
    `;

    const result = await this.executionLayer.execute({
      commandLine: reparentCommand
    });
    
    if (result.status !== 'success') {
      return this.embedViaXEmbed(windowId, containerId);
    }

    this.embeddedWindows.set(windowId, { windowId, containerId });

    return ok({
      success: true,
      containerId,
      windowId
    });
  }

  /**
   * تضمين عبر XEmbed Protocol
   */
  private async embedViaXEmbed(
    windowId: string,
    containerId: string
  ): Promise<Result<EmbedResult, Error>> {
    const xembedCommand = `
      if command -v xembedsniproxy &> /dev/null; then
        xembedsniproxy ${windowId} &
      else
        xdotool windowmove ${windowId} 0 0
        xdotool windowsize ${windowId} 100% 100%
      fi
    `;

    const result = await this.executionLayer.execute({
      commandLine: xembedCommand
    });
    
    if (result.status !== 'success') {
      return err(new Error(`XEmbed failed: ${result.stderr || result.reason || 'Execution failed'}`));
    }

    this.embeddedWindows.set(windowId, { windowId, containerId });

    return ok({
      success: true,
      containerId,
      windowId
    });
  }

  /**
   * تضمين على Wayland (Tiling أو Layer Shell)
   */
  private async embedWayland(
    windowId: string,
    containerId: string,
    strategy: EmbedStrategy
  ): Promise<Result<EmbedResult, Error>> {
    if (strategy === 'kpart') {
      return this.embedViaKPart(windowId, containerId);
    }

    const tileCommand = `
      hyprctl dispatch movetoworkspace 1,address:${windowId}
      hyprctl dispatch splitratio 0.5
      hyprctl dispatch resizeactive exact 50% 100%
    `;

    const result = await this.executionLayer.execute({
      commandLine: tileCommand
    });
    
    if (result.status !== 'success') {
      return err(new Error(`Wayland embedding not fully supported: ${result.stderr || result.reason || 'Tiling failed'}`));
    }

    this.embeddedWindows.set(windowId, { windowId, containerId });

    return ok({
      success: true,
      containerId,
      windowId,
      error: 'Window tiled alongside (not embedded) - Wayland limitation'
    });
  }

  /**
   * تضمين عبر KDE KParts
   */
  private async embedViaKPart(
    windowId: string,
    containerId: string
  ): Promise<Result<EmbedResult, Error>> {
    const dbusCommand = `
      qdbus org.kde.kpart.Embedder /Embedder \\
        org.kde.kpart.Embedder.embedWindow "${windowId}" "${containerId}"
    `;

    const result = await this.executionLayer.execute({
      commandLine: dbusCommand
    });
    
    if (result.status !== 'success') {
      return err(new Error(`KPart embedding failed: ${result.stderr || result.reason || 'D-Bus failed'}`));
    }

    this.embeddedWindows.set(windowId, { windowId, containerId });

    return ok({
      success: true,
      containerId,
      windowId
    });
  }

  /**
   * إزالة التضمين
   */
  async unembedWindow(windowId: string): Promise<Result<void, Error>> {
    const embedded = this.embeddedWindows.get(windowId);
    if (!embedded) {
      return ok(undefined);
    }

    if (this.displayServer === 'x11') {
      const result = await this.executionLayer.execute({
        commandLine: `xdotool windowreparent ${windowId} 0`
      });
      if (result.status !== 'success') {
        return err(new Error(`Failed to unembed: ${result.stderr || 'Command failed'}`));
      }
    }

    this.embeddedWindows.delete(windowId);
    return ok(undefined);
  }

  /**
   * تغيير حجم النافذة المضمنة
   */
  async resizeEmbedded(
    windowId: string,
    geometry: WindowGeometry
  ): Promise<Result<void, Error>> {
    if (this.displayServer === 'x11') {
      const command = `
        xdotool windowmove ${windowId} ${geometry.x} ${geometry.y}
        xdotool windowsize ${windowId} ${geometry.width} ${geometry.height}
      `;
      const result = await this.executionLayer.execute({
        commandLine: command
      });
      if (result.status !== 'success') {
        return err(new Error(`Resize failed: ${result.stderr || 'Command failed'}`));
      }
    }
    return ok(undefined);
  }

  /**
   * الحصول على النوافذ المضمنة
   */
  getEmbeddedWindows(): Array<{ windowId: string; containerId: string }> {
    return Array.from(this.embeddedWindows.values());
  }

  // ─── Private Methods ──────────────────────────────────────────────

  private detectDisplayServer(): DisplayServer {
    if (typeof process !== 'undefined' && process.env) {
      if (process.env.XDG_SESSION_TYPE === 'wayland' || process.env.WAYLAND_DISPLAY) {
        return 'wayland';
      }
    }
    return 'x11';
  }
}
