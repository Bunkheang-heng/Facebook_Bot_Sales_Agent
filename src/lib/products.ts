import type { RetrievedProduct } from '../services/rag';
import { logger } from '../core/logger';

/**
 * Configuration for product filtering and display
 */
export const PRODUCT_DISPLAY_CONFIG = {
  // Maximum products to show in carousel (even if more are retrieved)
  MAX_CAROUSEL_PRODUCTS: 2,
  
  // Minimum similarity score to display a product (0-1 scale)
  MIN_DISPLAY_SIMILARITY: 0.3,
  
  // Maximum products to retrieve for AI context
  MAX_RETRIEVE_FOR_CONTEXT: 5,
} as const;

/**
 * Filter and limit products for display in carousel
 * 
 * Strategy:
 * 1. Filter out low-similarity products
 * 2. Keep only top N most relevant products
 * 3. Log filtering decisions for monitoring
 * 
 * @param products All retrieved products
 * @param maxProducts Maximum number to display (default: 2)
 * @param minSimilarity Minimum similarity threshold (default: 0.3)
 * @returns Filtered products ready for display
 */
export function filterProductsForDisplay(
  products: RetrievedProduct[],
  maxProducts: number = PRODUCT_DISPLAY_CONFIG.MAX_CAROUSEL_PRODUCTS,
  minSimilarity: number = PRODUCT_DISPLAY_CONFIG.MIN_DISPLAY_SIMILARITY
): RetrievedProduct[] {
  if (!products || products.length === 0) {
    return [];
  }

  // Filter by similarity threshold
  const highQualityProducts = products.filter(p => p.similarity >= minSimilarity);

  if (highQualityProducts.length === 0) {
    logger.warn(
      { 
        totalProducts: products.length, 
        minSimilarity,
        topSimilarity: products[0]?.similarity 
      },
      '⚠️ No products meet similarity threshold'
    );
    // Fallback: show top product even if below threshold
    return products.slice(0, 1);
  }

  // Limit to top N products
  const displayProducts = highQualityProducts.slice(0, maxProducts);

  logger.info(
    {
      retrieved: products.length,
      afterFilter: highQualityProducts.length,
      displayed: displayProducts.length,
      filtered: products.length - displayProducts.length,
      topSimilarity: displayProducts[0]?.similarity,
      products: displayProducts.map(p => ({ 
        id: p.id, 
        name: p.name, 
        similarity: p.similarity?.toFixed(3) 
      }))
    },
    '🎯 Products filtered for optimal display'
  );

  return displayProducts;
}

/**
 * Check if products should be displayed based on quality
 * 
 * @param products Retrieved products
 * @returns true if products are good enough to show
 */
export function shouldDisplayProducts(products: RetrievedProduct[]): boolean {
  if (!products || products.length === 0) {
    return false;
  }

  const topSimilarity = products[0]?.similarity ?? 0;
  
  // Don't show products if top match is too low quality
  if (topSimilarity < PRODUCT_DISPLAY_CONFIG.MIN_DISPLAY_SIMILARITY) {
    logger.debug(
      { topSimilarity, threshold: PRODUCT_DISPLAY_CONFIG.MIN_DISPLAY_SIMILARITY },
      'Products not shown - similarity too low'
    );
    return false;
  }

  return true;
}

