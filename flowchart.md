```mermaid
    graph TD
    A[title screen] --> B[main menu]
    G[game screen]
    O[settings]
    C[mode1 check]
    C1[mode2 check]

    C-->|start|G
    C1-->|start|G
    B-->O
    B-->|marathon|C
    B-->C1


```