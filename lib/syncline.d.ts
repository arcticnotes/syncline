import EventEmitter from 'node:events';

declare module '@arcticnotes/syncline' {

	export interface SynclineSpawnOptions {

		/**
		 * Current working directory of the child process. Defaults to the CWD of the current process.
		 */
		cwd?: string;

		/**
		 * Environment variables. Defaults to the environment variables of the current process.
		 */
		env?: { [ key: string]: string};

		/**
		 * `argv[0]`, defaults to the command.
		 */
		argv0?: string;

		/**
		 * Trace level, 0 = off, 3 = all.
		 */
		trace?: number;
	}

	export class Syncline extends EventEmitter {

		/**
		 * Spawns a child process with the specified command name and arguments, and returns a {@link Promise} that resolves
		 * to a {@link Syncline}.
		 *
		 * @param command Command name
		 * @param args Arguments, defaults to empty array
		 * @param options Spawn options
		 */
		static async spawn( command: string, args?: string[], options?: SynclineSpawnOptions): Promise< Syncline> {
		}

		/**
		 * Sends a line of text to the child process and returns the next line from the child process.
		 *
		 * @param inputLine A line of input string
		 * @param timeout Optional timeout in milliseconds
		 */
		exchange( inputLine: string, timeout?: number): string {
		}

		/**
		 * Terminates the child process, if not already, and returns a {@link Promise} that resolves to one of the following:
		 *
		 * *  An object with property `code` set to the exit status code of the child process.
		 * *  An object with property `signal` set to the signal that terminated the child process.
		 */
		async close(): Promise< { code: number} | { signal: string}> {
		}
	}
}
