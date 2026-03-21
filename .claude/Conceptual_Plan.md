Build order: 

1. Project skeleton + shared contracts
 - shared/types
 - config
 - event schema
 - context package schema

2. Pi runtime adapter
 - get one minimal agent run working end-to-end
 - prompt in, result out

3. Orchestrator skeleton
 - wraps a Pi run
 - creates run_id
 - controls lifecycle stages
 - Run logger

4. SQLite
 - log run start, run end, major events, errors
 - now you have real executions to log
 - Stub context engine
 - return empty or hand-seeded context package
 - prove injection path into Pi works

5. Retrieval pipeline
 - note selection
 - tool-note selection
 - graph traversal from links
 - Synthesis/refine stage
 - compress retrieved notes into usable context
 - decide which tools to suggest/run

6. Tool execution integration
 - orchestrator runs selected tools
 - context engine packages tool outputs + note insights

7. Comparison engine
 - compare runs once you have enough logged runs

8. Insight generation
 - derive durable lessons
 - write back new/updated concept or tool notes