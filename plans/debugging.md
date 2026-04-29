Debugging & Observability patterns for the plugin:

   1. Chain Tracing: A "Debug Mode" that logs the exact input/output of every step (including resolved system prompts) to a dedicated "Crucible Logs" note or
      the console.
   2. Dry Run / Inspector: A way to "Preview" a chain step to see exactly what string is being sent to the LLM before it actually makes the API call.
   3. Intermediate State Capture: Allowing chains to write their intermediate {{response}} values to a temporary file or property so you can see where the
      logic diverged.

