---
id: web_search_001
type: tool
created: 20260321-120000
updated: 20260321-120000
tags: 
    - search
    - web
    - research
    - perplexity
---

# Web Search Tool

A provider-agnostic web search tool that performs intelligent web searches using AI models with real-time web access. Currently supports Perplexity AI with extensible design for future search providers.

## Description

The web search tool queries the web through AI search providers that can understand context, synthesize information from multiple sources, and provide coherent answers with proper citations. Unlike simple web scraping, this tool leverages AI models specifically trained for web search tasks.

**Key Features:**
- Provider-agnostic architecture (easily extensible)
- Structured results with citations
- Configurable search parameters
- Secure API key management
- CLI and programmatic interfaces

**Current Providers:**
- **Perplexity AI**: Real-time web search with citation-backed answers

## Usage Example

### Command Line Interface
```bash
# Basic search
npx tsx tools/web_search.ts "latest developments in quantum computing"

# Set environment variables for configuration
export PERPLEXITY_API_KEY="your-api-key-here"
export WEB_SEARCH_MODEL="llama-3.1-sonar-large-128k-online" 
npx tsx tools/web_search.ts "AI safety research 2024"
```

### Programmatic Usage
```typescript
import { webSearch } from './tools/web_search.js';

const result = await webSearch("OpenAI latest updates", {
  provider: 'perplexity',
  apiKey: 'your-key-here',
  maxTokens: 1500,
  temperature: 0.1
});

console.log(result.answer);
console.log(result.citations);
```

## Configuration

### Environment Variables
- `PERPLEXITY_API_KEY`: Your Perplexity API key (required)
- `WEB_SEARCH_PROVIDER`: Search provider (default: 'perplexity')
- `WEB_SEARCH_MODEL`: Model to use (default: 'llama-3.1-sonar-small-128k-online')
- `WEB_SEARCH_MAX_TOKENS`: Maximum response tokens (default: 1000)
- `WEB_SEARCH_TEMPERATURE`: Response temperature 0-1 (default: 0.1)

### Available Models (Perplexity)
- `llama-3.1-sonar-small-128k-online`: Fastest, good for quick searches
- `llama-3.1-sonar-large-128k-online`: More thorough analysis
- `llama-3.1-sonar-huge-128k-online`: Most comprehensive results

## Security

- API keys stored in environment variables (never hardcoded)
- Configurable timeout and rate limiting
- Input validation using Zod schemas
- Error handling with meaningful messages

## Future Extensions

The tool is designed to easily support additional providers:
- Google Search API
- Bing Search API
- Tavily AI
- Custom search endpoints

Links: 

[[tools]]
[[research]]
[[perplexity_api]]