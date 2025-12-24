
# Syncline

A Node.js library providing synchronous communication (without `async`/`await`, `Promise`s, or callbacks) with child
processes.

## What Does It Do?

This library spawns a child process of the specified command, interacts with its standard input/output/error streams
(*asynchronously* as usual), but exposes it to the client code as a *synchronous* function invocation.

```javascript
import {Syncline} from '@arcticnotes/syncline';

// Linux tips:
//    *  `tr a-z A-Z` command translates lower-case ASCII letters to upper-case.
//    *  `stdbuf -oL <command>` runs <command> but preconfigures its standard
//        output to be line-buffered.
const syncline = await Syncline.spawn('stdbuf', ['-oL', 'tr', 'a-z', 'A-Z']);
// notice that there is no `await` before `syncline.exchange()`, that's the goal
// of this library.
console.log(syncline.exchange('Hello, world!')); // prints 'HELLO, WORLD!'
await syncline.close();
```

## How Might It Be Useful?

Library/framework/platform authors may use this library to wrap an external executable, or an external network interface
through commands such as `nc` (`netcat`), and expose it as if it were an internal synchronous operation, either for
avoiding the need for asynchronous coordination, or because asynchronous operations are not allowed.

Note that since the JavaScript language itself is single-threaded by nature, invoking a blocking function means no other
activity can happen in the meantime, even the event handlers. Consider that when you decide to use this library.

## How Does It Work?

To return the result in the same synchronous call, we have to block the calling thread and do the IO processing in a
separate thread. The blocking is accomplished by `Atomics.wait()`, while the other thread is created by a `Worker`.
Since the main thread is blocked, it will not receive events (including StdErr events) until it is unblocked. The worker
is blocked in the state machine only for short slices of time, and is woken up for checking if there is any IO events
from the child process.

```
+---------------------------------------------------------------------------------+
| node process                                                                    |
|                                                                                 |
|   +-------------------------+                     +-------------------------+   |
|   | main thread             |                     | worker thread           |   |
|   |                         |      parentPort     |                         |   |
|   | event-handler <-------- | <------------------ | <----------+--------.   |   |
|   |               +---------+                     +---------+  ^        |   |   |
|   | exchange() -> |   State | <-----------------> | State   |<-+        |   |   |
|   |               | Machine |  SharedArrayBuffer  | Machine |  |        |   |   |
|   |               +---------+      + Atomics      +---------+  |        |   |   |
|   |                         |                     |   |        |        |   |   |
|   |                         |                     |   |     Buffer   Buffer |   |
|   |                         |                     |   |        |        |   |   |
|   +-------------------------+                     +---|---------------------+   |
|                                                       |        ^        ^       |
+-------------------------------------------------------|--------|--------|-------+
                                                        |        |        |
                                                        v StdIn  | StdOut | StdErr
                                                    +-------------------------+
                                                    | child process           |
                                                    |                         |
                                                    +-------------------------+
```

## Dependencies

*  Node.js release 20 or higher is required.

## License

This library is shared under the [MIT License](https://opensource.org/license/mit). See the `LICENSE` file for details.
