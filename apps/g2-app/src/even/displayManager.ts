/**
 * Owns the three glasses text containers (header / body / footer).
 *
 * The page is constructed exactly once with createStartUpPageContainer; every
 * subsequent update is a textContainerUpgrade routed through the serialized
 * RenderQueue. Body text is fitted to its box with @evenrealities/pretext
 * pixel measurement so long translations degrade to a word-safe ellipsis
 * instead of overflowing the panel.
 */

import {
  CreateStartUpPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk';
import { measureTextWrap } from '@evenrealities/pretext';
import type { AppConfig } from '../config';
import type { DisplayModel } from '../types';
import { toDisplayBlock, truncateWithEllipsis } from '../utils/text';
import type { EvenBridge } from './bridge';
import { RenderQueue } from './renderQueue';

export class DisplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DisplayError';
  }
}

type ContainerKey = 'header' | 'body' | 'footer';

export class DisplayManager {
  private readonly queue: RenderQueue;
  private readonly containersById: ReadonlyMap<number, { name: string }>;

  constructor(
    private readonly bridge: EvenBridge,
    private readonly config: AppConfig,
    onError?: (error: unknown) => void,
  ) {
    const { containers } = config.display;
    this.containersById = new Map(
      (Object.keys(containers) as ContainerKey[]).map((key) => [
        containers[key].id,
        { name: containers[key].name },
      ]),
    );
    this.queue = new RenderQueue(
      {
        write: async (containerId, content) => {
          const meta = this.containersById.get(containerId);
          const ok = await this.bridge.textContainerUpgrade(
            new TextContainerUpgrade({
              containerID: containerId,
              containerName: meta?.name,
              content,
            }),
          );
          if (!ok) {
            throw new DisplayError(`textContainerUpgrade rejected for container ${containerId}`);
          }
        },
      },
      config.display.renderDebounceMs,
      onError,
    );
  }

  /** Builds the startup page. Must complete before the mic can be opened. */
  async initialize(initial: DisplayModel): Promise<void> {
    const { containers } = this.config.display;
    const padding = this.config.display.containerPaddingPx;

    const makeContainer = (key: ContainerKey, content: string): TextContainerProperty =>
      new TextContainerProperty({
        xPosition: containers[key].x,
        yPosition: containers[key].y,
        width: containers[key].width,
        height: containers[key].height,
        borderWidth: 0,
        borderColor: 0,
        borderRadius: 0,
        paddingLength: padding,
        containerID: containers[key].id,
        containerName: containers[key].name,
        zOrderIndex: containers[key].zOrder,
        // Events must be captured by at least one container so taps and
        // swipes reach the app; the full-width body takes that role.
        isEventCapture: key === 'body' ? 1 : 0,
        content,
      });

    const result = await this.bridge.createStartUpPageContainer(
      new CreateStartUpPageContainer({
        containerTotalNum: 3,
        textObject: [
          makeContainer('header', initial.header),
          makeContainer('body', initial.body),
          makeContainer('footer', initial.footer),
        ],
      }),
    );

    if (result !== StartUpPageCreateResult.success) {
      throw new DisplayError(`createStartUpPageContainer failed with result ${result}`);
    }
  }

  /** Queues a full display model; identical content is skipped downstream. */
  show(model: DisplayModel): void {
    const { containers, maxDisplayedChars, containerPaddingPx } = this.config.display;
    // toDisplayBlock keeps the intentional line breaks of composed bodies
    // (transcript above, translation below) while still sanitizing each line.
    const fit = (key: ContainerKey, text: string): string =>
      fitTextToBox(
        toDisplayBlock(text, maxDisplayedChars),
        containers[key].width - 2 * containerPaddingPx,
        containers[key].height - 2 * containerPaddingPx,
      );
    this.queue.enqueue(containers.header.id, fit('header', model.header));
    this.queue.enqueue(containers.body.id, fit('body', model.body));
    this.queue.enqueue(containers.footer.id, fit('footer', model.footer));
  }

  async settle(): Promise<void> {
    await this.queue.settle();
  }

  dispose(): void {
    this.queue.dispose();
  }
}

/**
 * Shrinks text until pretext's wrap measurement says it fits the given pixel
 * box. Binary search over the character budget keeps this cheap even for the
 * longest translations.
 */
export function fitTextToBox(text: string, maxWidthPx: number, maxHeightPx: number): string {
  if (text.length === 0) return text;
  const fits = (candidate: string): boolean =>
    measureTextWrap(candidate, maxWidthPx).height <= maxHeightPx;

  if (fits(text)) return text;

  let low = 1;
  let high = text.length;
  let best = '';
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = truncateWithEllipsis(text, mid);
    if (fits(candidate)) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}
