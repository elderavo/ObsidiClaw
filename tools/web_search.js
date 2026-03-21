#!/usr/bin/env node
/**
 * Web Search Tool for ObsidiClaw
 *
 * A provider-agnostic web search tool that supports multiple search providers.
 * Currently supports Perplexity AI, with extensible design for future providers.
 */
import Perplexity from '@perplexity-ai/perplexity_ai';
import { z } from 'zod';
// Configuration schema
const WebSearchConfigSchema = z.object({
    provider: z.enum(['perplexity']).default('perplexity'),
    apiKey: z.string(),
    model: z.string().default('llama-3.1-sonar-small-128k-online'),
    maxTokens: z.number().default(1000),
    temperature: z.number().min(0).max(1).default(0.1),
});
// Search result schema
const SearchResultSchema = z.object({
    answer: z.string(),
    citations: z.array(z.object({
        title: z.string(),
        url: z.string(),
        snippet: z.string().optional(),
    })),
    rawResponse: z.object({}).optional(),
});
// Perplexity provider implementation
class PerplexityProvider {
    async search(query, config) {
        try {
            // Initialize Perplexity client with API key
            const client = new Perplexity({
                apiKey: config.apiKey
            });
            // Use the new search.create method with query array
            const search = await client.search.create({
                query: [query] // Query must be an array
            });
            // Process the results
            let answer = 'No answer received';
            const formattedCitations = [];
            if (search.results && search.results.length > 0) {
                // Extract information from results
                const resultSummaries = [];
                search.results.forEach((result, index) => {
                    const title = result.title || `Result ${index + 1}`;
                    const url = result.url || '';
                    const snippet = result.snippet || '';
                    // Add to citations
                    formattedCitations.push({
                        title,
                        url,
                        snippet: snippet.substring(0, 200) + (snippet.length > 200 ? '...' : '') // Truncate long snippets
                    });
                    // Create a meaningful summary from the snippet
                    if (snippet) {
                        resultSummaries.push(`**${title}**\n${snippet.substring(0, 300)}${snippet.length > 300 ? '...' : ''}\nSource: ${url}`);
                    }
                    else {
                        resultSummaries.push(`**${title}**\nSource: ${url}`);
                    }
                });
                // Create a comprehensive answer from the results
                answer = `Found ${search.results.length} relevant sources for "${query}":\n\n` +
                    resultSummaries.slice(0, 3).join('\n\n'); // Show first 3 results with context
            }
            return {
                answer,
                citations: formattedCitations,
                rawResponse: search
            };
        }
        catch (error) {
            throw new Error(`Perplexity API error: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
// Provider factory
function createProvider(providerName) {
    switch (providerName) {
        case 'perplexity':
            return new PerplexityProvider();
        default:
            throw new Error(`Unknown search provider: ${providerName}`);
    }
}
// Main search function
export async function webSearch(query, options = {}) {
    // Load config from environment and options
    const config = WebSearchConfigSchema.parse({
        provider: options.provider || process.env.WEB_SEARCH_PROVIDER || 'perplexity',
        apiKey: options.apiKey || process.env.PERPLEXITY_API_KEY || '',
        model: options.model || process.env.WEB_SEARCH_MODEL,
        maxTokens: options.maxTokens ?? (process.env.WEB_SEARCH_MAX_TOKENS ? Number(process.env.WEB_SEARCH_MAX_TOKENS) : undefined),
        temperature: options.temperature ?? (process.env.WEB_SEARCH_TEMPERATURE ? Number(process.env.WEB_SEARCH_TEMPERATURE) : undefined),
    });
    if (!config.apiKey) {
        throw new Error('API key is required. Set PERPLEXITY_API_KEY environment variable or pass apiKey option.');
    }
    const provider = createProvider(config.provider);
    return await provider.search(query, config);
}
// CLI interface
async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0) {
        console.error('Usage: web_search.ts "<search query>"');
        console.error('Example: web_search.ts "latest developments in AI"');
        console.error('');
        console.error('Environment variables:');
        console.error('  PERPLEXITY_API_KEY: Your Perplexity API key (required)');
        console.error('  WEB_SEARCH_PROVIDER: Search provider (default: perplexity)');
        console.error('  WEB_SEARCH_MODEL: Model to use (default: llama-3.1-sonar-small-128k-online)');
        console.error('  WEB_SEARCH_MAX_TOKENS: Max tokens (default: 1000)');
        console.error('  WEB_SEARCH_TEMPERATURE: Temperature (default: 0.1)');
        process.exit(1);
    }
    const query = args.join(' ');
    try {
        const result = await webSearch(query);
        console.log('## Web Search Results\n');
        console.log(`**Query:** ${query}\n`);
        console.log(`**Answer:**\n${result.answer}\n`);
        if (result.citations && result.citations.length > 0) {
            console.log('**Sources:**');
            result.citations.forEach((citation, index) => {
                console.log(`${index + 1}. [${citation.title}](${citation.url})`);
                if (citation.snippet) {
                    console.log(`   ${citation.snippet}`);
                }
            });
        }
    }
    catch (error) {
        console.error('Error:', error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
}
// Run CLI if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}
