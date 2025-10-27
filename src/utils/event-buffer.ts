import { logger } from '../logger';

/**
 * Event buffer to collect related text + image events from the same user
 * Facebook sends text and image as separate webhook events within ~1 second
 * We buffer them and process together to generate ONE AI response
 */

type BufferedEvent = {
  senderId: string;
  messageText: string;
  imageUrl: string | undefined;
  mid: string | undefined;
  timestamp: number;
};

type ProcessCallback = (event: BufferedEvent) => void;

export class EventBuffer {
  private buffer = new Map<string, BufferedEvent>();
  private timers = new Map<string, NodeJS.Timeout>();
  private readonly waitTimeMs: number;

  constructor(waitTimeMs: number = 2000) {
    this.waitTimeMs = waitTimeMs;
  }

  /**
   * Add an event to the buffer
   * If text + image arrive within waitTime, they'll be merged
   */
  addEvent(
    senderId: string,
    messageText: string,
    imageUrl: string | undefined,
    mid: string | undefined,
    callback: ProcessCallback
  ): void {
    const existing = this.buffer.get(senderId);
    const now = Date.now();

    // If there's a recent event from this user, merge it
    if (existing && (now - existing.timestamp) < this.waitTimeMs) {
      logger.info(
        { 
          senderId,
          hadText: !!existing.messageText,
          hadImage: !!existing.imageUrl,
          newText: !!messageText,
          newImage: !!imageUrl
        },
        '🔗 EventBuffer: Merging related events'
      );

      // Merge: keep longest text, add image if new
      const merged: BufferedEvent = {
        senderId,
        messageText: messageText.length > existing.messageText.length ? messageText : existing.messageText,
        imageUrl: imageUrl || existing.imageUrl,
        mid: mid || existing.mid,
        timestamp: existing.timestamp // Keep original timestamp
      };

      // Clear existing timer
      const timer = this.timers.get(senderId);
      if (timer) {
        clearTimeout(timer);
        this.timers.delete(senderId);
      }

      // Update buffer
      this.buffer.set(senderId, merged);

      // Schedule processing (give a bit more time in case more events arrive)
      const newTimer = setTimeout(() => {
        const final = this.buffer.get(senderId);
        if (final) {
          logger.info(
            {
              senderId,
              hasText: !!final.messageText,
              hasImage: !!final.imageUrl,
              textLength: final.messageText.length
            },
            '✅ EventBuffer: Processing merged event'
          );
          this.buffer.delete(senderId);
          this.timers.delete(senderId);
          callback(final);
        }
      }, 500); // Short delay to catch any final events

      this.timers.set(senderId, newTimer);
      return;
    }

    // No existing event, create new buffer entry
    logger.info(
      {
        senderId,
        hasText: !!messageText,
        hasImage: !!imageUrl,
        waitMs: this.waitTimeMs
      },
      '⏳ EventBuffer: Buffering new event'
    );

    const event: BufferedEvent = {
      senderId,
      messageText,
      imageUrl,
      mid,
      timestamp: now
    };

    this.buffer.set(senderId, event);

    // Schedule processing after wait time
    const timer = setTimeout(() => {
      const final = this.buffer.get(senderId);
      if (final) {
        logger.info(
          {
            senderId,
            hasText: !!final.messageText,
            hasImage: !!final.imageUrl,
            textLength: final.messageText.length
          },
          '✅ EventBuffer: Processing buffered event (timeout)'
        );
        this.buffer.delete(senderId);
        this.timers.delete(senderId);
        callback(final);
      }
    }, this.waitTimeMs);

    this.timers.set(senderId, timer);
  }

  /**
   * Clear all buffers and timers
   */
  clear(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.buffer.clear();
    this.timers.clear();
  }

  /**
   * Get buffer size (for monitoring)
   */
  size(): number {
    return this.buffer.size;
  }
}

