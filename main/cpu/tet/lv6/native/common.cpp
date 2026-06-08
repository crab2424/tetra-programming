#include "common.h"
#include <cmath>

const MinoData MINO_TEMPLATES[7] = {
    {{{0,1},{1,1},{2,1},{3,1}}, 1.5f, 1.5f},
    {{{1,1},{2,1},{1,2},{2,2}}, 1.5f, 1.5f},
    {{{1,1},{0,2},{1,2},{2,2}}, 1.0f, 2.0f},
    {{{0,1},{0,2},{1,2},{2,2}}, 1.0f, 2.0f},
    {{{2,1},{0,2},{1,2},{2,2}}, 1.0f, 2.0f},
    {{{1,1},{2,1},{0,2},{1,2}}, 1.0f, 2.0f},
    {{{0,1},{1,1},{1,2},{2,2}}, 1.0f, 2.0f}
};

GridBlock PRECALC_MINO_BLOCKS[7][4][4];
static bool isPrecalcDone = false;

void ensurePrecalc() {
    if (isPrecalcDone) return;
    for (int type = 0; type < 7; type++) {
        for (int rot = 0; rot < 4; rot++) {
            MinoData tmpl = MINO_TEMPLATES[type];
            for (int i = 0; i < 4; i++) {
                float relX = tmpl.blocks[i].x - tmpl.pivotX;
                float relY = tmpl.blocks[i].y - tmpl.pivotY;
                float newX = relX, newY = relY;
                for (int r = 0; r < rot; r++) {
                    float tempX = -newY; float tempY = newX;
                    newX = tempX; newY = tempY;
                }
                PRECALC_MINO_BLOCKS[type][rot][i].x = std::round(newX + tmpl.pivotX);
                PRECALC_MINO_BLOCKS[type][rot][i].y = std::round(newY + tmpl.pivotY);
            }
        }
    }
    isPrecalcDone = true;
}
