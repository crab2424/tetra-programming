# fast モード（未実装）

ぷよCPU lv4 のモード別探索ディレクトリ。現状は `build` モードのみ実装済み。
このモードを実装する際は `fast.h` / `fast.cpp` を追加し、native/build.sh の SRCS と
native/cpu4.cpp の searchBestMovePuyoWasm 内のモード振り分けに登録すること。
ama-beam の ai/search/{dfs,beam} の構成が参考になる。
