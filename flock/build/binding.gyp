{
  "targets": [
    {
      "target_name": "flock",
      "sources": [ "../src/flock.c" ],
      "include_dirs": [ "!<(process.env.NODE_INCLUDE || '<(node_root_dir)/include/node')" ],
      "cflags": [ "-fPIC" ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS" ]
    }
  ]
}
