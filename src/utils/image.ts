import axios from 'axios';
import { logger } from '../logger';

/**
 * Download image from URL and convert to base64
 * @param imageUrl URL of the image to download
 * @param pageAccessToken Facebook page access token for authenticated downloads
 * @returns Base64 encoded image data
 */
export async function downloadImageAsBase64(imageUrl: string, pageAccessToken?: string): Promise<string> {
  logger.info({ imageUrl: imageUrl.slice(0, 100) }, 'Downloading image');

  try {
    const headers: any = {};
    
    // For Facebook CDN images, include auth token
    if (imageUrl.includes('fbcdn.net') && pageAccessToken) {
      headers['Authorization'] = `Bearer ${pageAccessToken}`;
    }

    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      headers,
      timeout: 10000, // 10 second timeout
      maxContentLength: 10 * 1024 * 1024, // 10MB max
    });

    const base64 = Buffer.from(response.data).toString('base64');
    
    logger.info(
      { 
        imageUrl: imageUrl.slice(0, 100),
        sizeKB: Math.round(base64.length / 1024),
        contentType: response.headers['content-type']
      },
      'Image downloaded successfully'
    );

    return base64;
  } catch (error: any) {
    logger.error(
      { 
        imageUrl: imageUrl.slice(0, 100),
        error: error.message,
        status: error.response?.status
      },
      '❌ Failed to download image'
    );
    throw new Error(`Failed to download image: ${error.message}`);
  }
}

/**
 * Validate if URL is a valid image URL
 */
export function isValidImageUrl(url: string): boolean {
  if (!url || typeof url !== 'string') {
    return false;
  }

  try {
    const parsed = new URL(url);
    
    // Check for valid protocols
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return false;
    }

    // Check for common image extensions or Facebook CDN
    const isImageExtension = /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(parsed.pathname);
    const isFacebookCDN = url.includes('fbcdn.net') || url.includes('fbsbx.com');
    
    return isImageExtension || isFacebookCDN;
  } catch {
    return false;
  }
}

/**
 * Get content type from image URL or data
 */
export function getImageContentType(url: string): string {
  const lower = url.toLowerCase();
  
  if (lower.includes('.png')) return 'image/png';
  if (lower.includes('.gif')) return 'image/gif';
  if (lower.includes('.webp')) return 'image/webp';
  if (lower.includes('.bmp')) return 'image/bmp';
  
  // Default to JPEG (most common)
  return 'image/jpeg';
}

