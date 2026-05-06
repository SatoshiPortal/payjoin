let _isShuttingDown: () => boolean;
let _trackTask: <T>(taskName: string, task: () => Promise<T>) => Promise<T>;

export function setGracefulShutdownRefs(isShuttingDown: () => boolean, trackTask: <T>(taskName: string, task: () => Promise<T>) => Promise<T>) {
  _isShuttingDown = isShuttingDown;
  _trackTask = trackTask;
}

export const isShuttingDown = () => _isShuttingDown ? _isShuttingDown() : false;

export const trackTask = <T>(taskName: string, task: () => Promise<T>) => _trackTask ? _trackTask(taskName, task) : task();