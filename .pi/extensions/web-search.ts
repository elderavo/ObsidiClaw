/**
 * Web Search Extension for Pi
 * 
 * Provides web search functionality through the Perplexity API.
 * Registers a web_search tool that can be used by Claude.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import Perplexity from '@perplexity-ai/perplexity_ai';

// Types for search results
interface SearchResult {
  answer: string;
  citations: Array<{
    title: string;
    url: string;
    snippet?: string;
  }>;
}

// Main web search function
async function webSearch(query: string): Promise<SearchResult> {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) {
    throw new Error('PERPLEXITY_API_KEY environment variable is required');
  }

  try {
    // Initialize Perplexity client
    const client = new Perplexity({
      apiKey: apiKey
    });

    // Use the search.create method with query array (per Perplexity docs)
    const search = await client.search.create({
      query: [query] // Query must be an array
    });

    // Process the results
    let answer = 'No answer received';
    const formattedCitations: Array<{title: string, url: string, snippet?: string}> = [];

    if (search.results && search.results.length > 0) {
      // Extract information from results
      const resultSummaries: string[] = [];
      
      search.results.forEach((result: any, index: number) => {
        const title = result.title || `Result ${index + 1}`;
        const url = result.url || '';
        const snippet = result.snippet || '';
        
        // Add to citations
        formattedCitations.push({
          title,
          url,
          snippet: snippet.substring(0, 200) + (snippet.length > 200 ? '...' : '')
        });
        
        // Create a meaningful summary from the snippet
        if (snippet) {
          resultSummaries.push(`**${title}**\n${snippet.substring(0, 300)}${snippet.length > 300 ? '...' : ''}\nSource: ${url}`);
        } else {
          resultSummaries.push(`**${title}**\nSource: ${url}`);
        }
      });
      
      // Create a comprehensive answer from the results
      answer = `Found ${search.results.length} relevant sources for "${query}":\n\n` + 
              resultSummaries.slice(0, 3).join('\n\n');
    }

    return {
      answer,
      citations: formattedCitations
    };
  } catch (error) {
    throw new Error(`Perplexity API error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export default function webSearchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web for current information using Perplexity AI. " +
      "Returns an answer with citations from recent web sources.",
    promptSnippet: "web_search(query) — search the web for current information",
    promptGuidelines: [
      "Use this tool when you need current information that may not be in your training data",
      "Especially useful for recent events, news, product releases, or real-time information",
      "The tool provides both an AI-generated answer and source citations"
    ],
    parameters: Type.Object({
      query: Type.String({
        description: "The search query to find information about",
      }),
    }),
    async execute(_toolCallId, { query }, _signal, _onUpdate, ctx) {
      try {
        ctx?.ui?.setWorkingMessage?.("Searching the web...");
        
        const result = await webSearch(query);
        
        // Format the response with answer and citations
        let response = `## Web Search Results\n\n`;
        response += `**Query:** ${query}\n\n`;
        response += `**Answer:**\n${result.answer}\n\n`;
        
        if (result.citations && result.citations.length > 0) {
          response += `**Sources:**\n`;
          result.citations.forEach((citation, index) => {
            response += `${index + 1}. [${citation.title}](${citation.url})`;
            if (citation.snippet) {
              response += `\n   ${citation.snippet}`;
            }
            response += `\n`;
          });
        }

        ctx?.ui?.setWorkingMessage?.();
        
        return {
          content: [{ type: "text" as const, text: response }],
          details: { 
            query,
            citationCount: result.citations?.length || 0,
            provider: "perplexity"
          },
        };
      } catch (error) {
        ctx?.ui?.setWorkingMessage?.();
        
        // Better error handling
        let errorMessage = 'Unknown error occurred';
        if (error instanceof Error) {
          errorMessage = error.message;
        } else if (typeof error === 'object' && error !== null) {
          errorMessage = JSON.stringify(error, null, 2);
        } else {
          errorMessage = String(error);
        }
        
        return {
          content: [{ 
            type: "text" as const, 
            text: `Error performing web search: ${errorMessage}` 
          }],
          details: { 
            query,
            error: errorMessage
          },
        };
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    // Check if API key is configured
    if (!process.env.PERPLEXITY_API_KEY) {
      ctx.ui.notify("Web search tool registered but PERPLEXITY_API_KEY not set", "warning");
    } else {
      ctx.ui.notify("Web search tool registered successfully", "info");
    }
  });
}