import type { RetrievedProduct } from '../services/rag';
import { logger } from '../logger';

/**
 * Extract product names mentioned in AI response
 * Looks for product names in bold or quotes
 * 
 * Example patterns:
 * - "the *ProductName* for"
 * - "recommend the **ProductName** because"
 * - 'the "ProductName" is'
 */
export function extractMentionedProducts(aiResponse: string, availableProducts: RetrievedProduct[]): RetrievedProduct[] {
  if (!availableProducts || availableProducts.length === 0) {
    return [];
  }

  const mentioned: RetrievedProduct[] = [];
  const lowerResponse = aiResponse.toLowerCase();

  // Check each product to see if it's mentioned in the response
  for (const product of availableProducts) {
    const productName = product.name.toLowerCase();
    
    // Look for product name in the response (case-insensitive, partial match)
    // This handles cases like "Men's Intercoastal Performance Pant" being mentioned
    if (lowerResponse.includes(productName)) {
      mentioned.push(product);
      continue;
    }

    // Try matching partial names (e.g., "Intercoastal Performance Pant")
    const words = productName.split(/\s+/).filter(w => w.length > 3); // Skip short words like "men's", "the"
    let matchCount = 0;
    for (const word of words) {
      if (lowerResponse.includes(word)) {
        matchCount++;
      }
    }
    
    // If at least 2 significant words match, consider it mentioned
    if (matchCount >= 2 && words.length >= 2) {
      mentioned.push(product);
    }
  }

  logger.info(
    {
      totalProducts: availableProducts.length,
      mentioned: mentioned.length,
      mentionedProducts: mentioned.map(p => p.name),
      responsePreview: aiResponse.slice(0, 150)
    },
    '🎯 AI Product Matcher: Extracted mentioned products'
  );

  return mentioned;
}

export function getProductsForCarousel(
  aiResponse: string,
  allProducts: RetrievedProduct[],
  maxDisplay: number = 2,
  minSimilarity: number = 0.3
): RetrievedProduct[] {
  if (!allProducts || allProducts.length === 0) {
    return [];
  }

  // Step 1: Find products actually mentioned in AI response
  const mentionedProducts = extractMentionedProducts(aiResponse, allProducts);

  if (mentionedProducts.length > 0) {
    // Show products AI actually talks about (up to maxDisplay)
    const filtered = mentionedProducts
      .filter(p => p.similarity >= minSimilarity)
      .slice(0, maxDisplay);
    
    logger.info(
      {
        strategy: 'ai_mentioned',
        mentioned: mentionedProducts.length,
        displayed: filtered.length,
        products: filtered.map(p => ({ name: p.name, similarity: p.similarity?.toFixed(3) }))
      },
      'Carousel: Showing AI-mentioned products'
    );
    
    return filtered;
  }

  // Step 2: Fallback - no products mentioned, show top matches
  const topMatches = allProducts
    .filter(p => p.similarity >= minSimilarity)
    .slice(0, maxDisplay);

  if (topMatches.length === 0) {
    // Last resort: show top 1 product even if below threshold
    logger.warn(
      { topSimilarity: allProducts[0]?.similarity, threshold: minSimilarity },
      '⚠️ Carousel: No products meet threshold, showing top match anyway'
    );
    return allProducts.slice(0, 1);
  }

  logger.info(
    {
      strategy: 'top_similarity',
      displayed: topMatches.length,
      products: topMatches.map(p => ({ name: p.name, similarity: p.similarity?.toFixed(3) }))
    },
    '📊 Carousel: Showing top similarity matches (no AI mention)'
  );

  return topMatches;
}

/**
 * Check if products should be displayed at all
 * Don't show carousel if quality is too low or no relevant products
 */
export function shouldShowCarousel(
  aiResponse: string,
  products: RetrievedProduct[],
  minSimilarity: number = 0.3
): boolean {
  if (!products || products.length === 0) {
    return false;
  }

  // If AI mentions specific products, always show them
  const mentioned = extractMentionedProducts(aiResponse, products);
  if (mentioned.length > 0 && mentioned[0] && mentioned[0].similarity >= minSimilarity * 0.7) {
    return true;
  }

  // Otherwise check if top product is good enough
  const topSimilarity = products[0]?.similarity ?? 0;
  return topSimilarity >= minSimilarity;
}

