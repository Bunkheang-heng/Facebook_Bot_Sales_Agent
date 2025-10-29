/**
 * Query Enhancement for RAG Accuracy
 * 
 * This module improves semantic search accuracy by:
 * 1. Extracting category keywords from user queries
 * 2. Boosting queries with explicit category context
 * 3. Post-filtering results based on category relevance
 */

// Category mappings with synonyms and related terms
const CATEGORY_KEYWORDS = {
  // Footwear
  shoes: ['shoe', 'shoes', 'sneaker', 'sneakers', 'boot', 'boots', 'sandal', 'sandals', 'footwear', 'kicks'],
  
  // Bottoms
  pants: ['pant', 'pants', 'trouser', 'trousers', 'jeans', 'slacks', 'chinos', 'jogger', 'joggers', 'leggings', 'bottoms'],
  
  // Tops
  shirts: ['shirt', 'shirts', 't-shirt', 'tshirt', 'tee', 'polo', 'blouse', 'top', 'tops'],
  
  // Outerwear
  jackets: ['jacket', 'jackets', 'coat', 'coats', 'blazer', 'blazers', 'parka', 'windbreaker', 'hoodie', 'hoodies', 'sweater', 'sweaters', 'cardigan', 'outerwear'],
  
  // Dresses & Skirts
  dresses: ['dress', 'dresses', 'gown', 'gowns', 'skirt', 'skirts'],
  
  // Accessories
  accessories: ['hat', 'hats', 'cap', 'caps', 'bag', 'bags', 'belt', 'belts', 'scarf', 'scarves', 'gloves', 'socks', 'watch', 'watches', 'jewelry', 'accessory', 'accessories'],
  
  // Sportswear
  sportswear: ['sport', 'sports', 'athletic', 'workout', 'gym', 'fitness', 'training', 'running', 'yoga', 'activewear']
};

/**
 * Extract category keywords from user query
 */
export function extractCategoryFromQuery(query: string): string[] {
  const lowerQuery = query.toLowerCase();
  const detectedCategories: string[] = [];
  
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const keyword of keywords) {
      // Use word boundaries to match whole words only
      const regex = new RegExp(`\\b${keyword}\\b`, 'i');
      if (regex.test(lowerQuery)) {
        detectedCategories.push(category);
        break; // Only add category once even if multiple keywords match
      }
    }
  }
  
  return detectedCategories;
}

/**
 * Enhance query with category context for better embeddings
 * 
 * Example:
 * - Input: "blue shoes"
 * - Output: "blue shoes footwear sneakers"
 * 
 * This helps the embedding model understand the category better
 */
export function enhanceQueryWithCategory(query: string): string {
  const categories = extractCategoryFromQuery(query);
  
  if (categories.length === 0) {
    return query; // No category detected, return original
  }
  
  // Add category keywords to boost relevance
  const categoryBoost = categories
    .flatMap(cat => CATEGORY_KEYWORDS[cat as keyof typeof CATEGORY_KEYWORDS]?.slice(0, 3) || [])
    .join(' ');
  
  return `${query} ${categoryBoost}`.trim();
}

/**
 * Check if a product matches the detected category
 */
export function productMatchesCategory(productName: string, productCategory: string | null, queryCategories: string[]): boolean {
  if (queryCategories.length === 0) {
    return true; // No category filter, accept all
  }
  
  const lowerName = productName.toLowerCase();
  const lowerCategory = (productCategory || '').toLowerCase();
  
  // Check if product name or category contains any of the category keywords
  for (const category of queryCategories) {
    const keywords = CATEGORY_KEYWORDS[category as keyof typeof CATEGORY_KEYWORDS] || [];
    
    for (const keyword of keywords) {
      const regex = new RegExp(`\\b${keyword}`, 'i');
      if (regex.test(lowerName) || regex.test(lowerCategory)) {
        return true;
      }
    }
  }
  
  return false;
}

/**
 * Filter and re-rank products based on category relevance
 * 
 * Strategy:
 * 1. Boost products that match the detected category
 * 2. Penalize products that don't match
 * 3. Sort by adjusted similarity score
 */
export function filterAndRankByCategory<T extends { name: string; category?: string | null; similarity: number }>(
  products: T[],
  query: string,
  strictFilter: boolean = false
): T[] {
  const categories = extractCategoryFromQuery(query);
  
  if (categories.length === 0) {
    return products; // No category detected, return as-is
  }
  
  const scored = products.map(product => {
    const matches = productMatchesCategory(
      product.name,
      product.category || null,
      categories
    );
    
    let adjustedSimilarity = product.similarity;
    
    if (matches) {
      // Boost by 50% if category matches
      adjustedSimilarity *= 1.5;
    } else if (strictFilter) {
      // In strict mode, heavily penalize non-matches (90% penalty)
      adjustedSimilarity *= 0.1;
    } else {
      // In lenient mode, moderate penalty for non-matches (50% penalty)
      adjustedSimilarity *= 0.5;
    }
    
    return {
      ...product,
      originalSimilarity: product.similarity,
      adjustedSimilarity,
      categoryMatch: matches
    };
  });
  
  // Sort by adjusted similarity
  const sorted = scored.sort((a, b) => b.adjustedSimilarity - a.adjustedSimilarity);
  
  // In strict mode, ONLY return category matches (unless no matches found)
  if (strictFilter) {
    const categoryMatches = sorted.filter(p => p.categoryMatch);
    // If we have category matches, only return those
    if (categoryMatches.length > 0) {
      return categoryMatches as T[];
    }
    // Otherwise, return all with warning
    return sorted as T[];
  }
  
  // In lenient mode, still prefer category matches but allow others
  return sorted as T[];
}

