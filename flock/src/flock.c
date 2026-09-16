/*
 * Node-API v8 binding for asynchronous flock(LOCK_EX | LOCK_NB).
 * The caller owns fd through completion; this module never opens, duplicates,
 * closes, or explicitly unlocks it. The callback receives zero or a positive
 * errno; JavaScript owns the promise and syscall error construction.
 */

#include <node_api.h>
#include <errno.h>
#include <limits.h>
#include <stdlib.h>
#include <sys/file.h>
#include <fcntl.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <stdbool.h>

typedef struct {
  napi_env env;
  napi_ref callback;
  napi_async_work work;
  napi_async_cleanup_hook_handle cleanup;
  int fd;
  int error;
  bool closing;
} lock_request;

static void check_status(napi_status status, const char *message) {
  if (status != napi_ok) {
    napi_fatal_error("flock", NAPI_AUTO_LENGTH, message, NAPI_AUTO_LENGTH);
  }
}

static void release_request(lock_request *request) {
  if (request->callback != NULL) {
    (void)napi_delete_reference(request->env, request->callback);
  }
  if (request->work != NULL) {
    (void)napi_delete_async_work(request->env, request->work);
  }
  if (request->cleanup != NULL) {
    (void)napi_remove_async_cleanup_hook(request->cleanup);
  }
  free(request);
}

static napi_value throw_setup_error(napi_env env, napi_status status,
                                   const char *message) {
  if (status != napi_pending_exception) {
    status = napi_throw_error(env, "ERR_FLOCK_ASYNC_WORK", message);
    bool pending;
    /* Error construction can fail with both generic_failure and a JS exception. */
    check_status(napi_is_exception_pending(env, &pending), "Cannot inspect flock setup exception");
    if (!pending && status != napi_pending_exception) check_status(status, message);
  }
  return NULL;
}

static void execute_lock(napi_env env, void *data) {
  (void)env;
  lock_request *request = data;
  request->error = flock(request->fd, LOCK_EX | LOCK_NB) == 0 ? 0 : errno;
}

static void complete_lock(napi_env env, napi_status status, void *data) {
  lock_request *request = data;
  if (env != NULL && !request->closing) {
    napi_value callback;
    napi_value receiver;
    napi_value result;
    check_status(status, "flock async work did not complete");
    check_status(napi_get_reference_value(env, request->callback, &callback),
                 "Cannot retrieve flock callback");
    check_status(napi_get_undefined(env, &receiver), "Cannot create flock receiver");
    check_status(napi_create_int32(env, request->error, &result),
                 "Cannot create flock result");
    status = napi_call_function(env, receiver, callback, 1, &result, NULL);
  } else {
    status = napi_ok;
  }
  release_request(request);
  /* Node's async-work dispatcher reports callback exceptions and handles termination. */
  if (status != napi_pending_exception) {
    check_status(status, "Cannot invoke flock callback");
  }
}

static void cleanup_lock(napi_async_cleanup_hook_handle handle, void *data) {
  (void)handle;
  lock_request *request = data;
  request->closing = true;
  /*
   * Running work cannot be cancelled. The hook keeps the environment alive
   * until completion releases both the work and this hook; it never frees
   * memory that the execution thread can still access.
   */
  (void)napi_cancel_async_work(request->env, request->work);
}

static napi_value try_lock(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  double fd;
  napi_status status = napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (status != napi_ok) {
    return throw_setup_error(env, status, "Cannot read flock arguments");
  }
  if (argc < 1 || napi_get_value_double(env, argv[0], &fd) != napi_ok) {
    (void)napi_throw_type_error(env, NULL, "fd must be a number");
    return NULL;
  }
  if (!(fd >= INT_MIN && fd <= INT_MAX) || fd != (int)fd) {
    (void)napi_throw_range_error(env, NULL, "fd must be a signed C int");
    return NULL;
  }
  napi_valuetype callback_type;
  if (argc < 2 || napi_typeof(env, argv[1], &callback_type) != napi_ok ||
      callback_type != napi_function) {
    (void)napi_throw_type_error(env, NULL, "callback must be a function");
    return NULL;
  }

  lock_request *request = calloc(1, sizeof(*request));
  if (request == NULL) {
    (void)napi_throw_error(env, "ENOMEM", "Cannot allocate flock async work");
    return NULL;
  }
  request->env = env;
  request->fd = (int)fd;

  status = napi_create_reference(env, argv[1], 1, &request->callback);
  if (status != napi_ok) {
    release_request(request);
    return throw_setup_error(env, status, "Cannot retain flock callback");
  }
  napi_value name;
  status = napi_create_string_utf8(env, "flock", NAPI_AUTO_LENGTH, &name);
  if (status == napi_ok) {
    status = napi_create_async_work(env, NULL, name, execute_lock, complete_lock,
                                   request, &request->work);
  }
  if (status != napi_ok) {
    release_request(request);
    return throw_setup_error(env, status, "Cannot create flock async work");
  }
  status = napi_add_async_cleanup_hook(env, cleanup_lock, request, &request->cleanup);
  if (status != napi_ok) {
    release_request(request);
    return throw_setup_error(env, status, "Cannot register flock environment cleanup");
  }
  status = napi_queue_async_work(env, request->work);
  if (status != napi_ok) {
    /* Queue failure schedules no completion callback. */
    release_request(request);
    return throw_setup_error(env, status, "Cannot queue flock async work");
  }
  return NULL;
}

/* Publish a staged file without ever replacing another creator's file.
 * A plain rename() cannot provide this guarantee. Linux/Android expose
 * renameat2(RENAME_NOREPLACE); unsupported filesystems return an error.
 */
static napi_value publish_no_replace(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2], result;
  char *paths[2] = {NULL, NULL};
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 2) {
    napi_throw_type_error(env, NULL, "Two paths are required");
    return NULL;
  }
  for (int i = 0; i < 2; i++) {
    size_t length;
    if (napi_get_value_string_utf8(env, argv[i], NULL, 0, &length) != napi_ok) {
      free(paths[0]);
      napi_throw_type_error(env, NULL, "Paths must be strings");
      return NULL;
    }
    paths[i] = malloc(length + 1);
    if (!paths[i]) {
      free(paths[0]);
      napi_throw_error(env, "ENOMEM", "Cannot allocate path");
      return NULL;
    }
    if (napi_get_value_string_utf8(env, argv[i], paths[i], length + 1, &length) != napi_ok) {
      free(paths[0]); free(paths[1]);
      napi_throw_type_error(env, NULL, "Cannot read path");
      return NULL;
    }
  }
  int error = 0;
  if (syscall(SYS_renameat2, AT_FDCWD, paths[0], AT_FDCWD, paths[1], 1U) != 0)
    error = errno;
  free(paths[0]); free(paths[1]);
  if (napi_create_int32(env, error, &result) != napi_ok) return NULL;
  return result;
}

NAPI_MODULE_INIT() {
  napi_value function;
  if (napi_create_function(env, "tryLock", NAPI_AUTO_LENGTH, try_lock,
                           NULL, &function) != napi_ok ||
      napi_set_named_property(env, exports, "tryLock", function) != napi_ok) {
    return NULL;
  }
  if (napi_create_function(env, "publishNoReplace", NAPI_AUTO_LENGTH, publish_no_replace,
                          NULL, &function) != napi_ok ||
      napi_set_named_property(env, exports, "publishNoReplace", function) != napi_ok) return NULL;
  return exports;
}
