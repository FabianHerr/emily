// emily_face.h: Emily's cloud face for the T-Watch S3 screen (240x240), built from plain LVGL objects.
//
// NOT COMPILED OR TESTED ON THE WATCH. Written against the LVGL 9 API that watch.ino already uses
// (lv_screen_active, lv_button_create, lv_obj_remove_flag, lv_line_set_points with
// lv_point_precise_t). Check it in Arduino IDE before relying on it.
//
// How to wire it into watch.ino:
//   #define USE_EMILY_FACE 1
//   #include "emily_face.h"                                   // next to the other includes
//   emilyFaceCreate(lv_screen_active());                      // last line of setupScreen()
//   // fall detected:   emilyFaceSetMood(EmilyMood::Worried); emilyFaceShowButtons(onOkPressed, onHelpPressed);
//   // before a WAV:    emilyFaceSetMood(EmilyMood::Talking); refreshScreenNow();
//   // conversation over: emilyFaceSetMood(EmilyMood::Calm); emilyFaceHideButtons();
//   // old text screen: emilyFaceShow(false);
//
// Honest notes:
// - playWAV() in this sketch is blocking, so the talking mouth only moves if lv_timer_handler()
//   runs during playback. Otherwise the screen freezes on the open mouth that Talking sets at once.
// - Call every function here only from loop() (the thread that calls lv_timer_handler()),
//   never from the network task. LVGL is not thread-safe.
// - The face covers the old labels. It does not catch taps, so the old "Simulate fall" button
//   under it (bottom middle) still works while Emily's buttons are hidden.
// - What onOk / onHelp should DO (for example send the answer to the backend) is the watch
//   owner's call. The backend is adding an optional answer=ok|help parameter on POST /fall.
//   Keep the callbacks short (set a flag): refreshScreenNow() inside a blocking step can run them.
#pragma once

#include <lvgl.h>

enum class EmilyMood { Calm, Worried, Talking };

// ---- Tunable numbers ----
static const uint32_t EMILY_BLINK_MS[] = {4200, 5600, 4800, 5200};  // time between blinks
static const uint32_t EMILY_BLINK_CLOSED_MS = 120;
static const uint32_t EMILY_TALK_TICK_MS = 160;   // mouth opens or closes every tick
static const int32_t EMILY_BOB_PX = 2;

// ---- Colors ----
#define EMILY_SKY lv_color_hex(0xCDE5F7)
#define EMILY_CORAL lv_color_hex(0xFFC8B4)
#define EMILY_CLOUD lv_color_hex(0xF4F9FD)
#define EMILY_NAVY lv_color_hex(0x16324A)
#define EMILY_CHEEK lv_color_hex(0xFF9F85)
#define EMILY_HELP_BG lv_color_hex(0x9A2B13)
#define EMILY_OK_BG lv_color_hex(0x1D4C78)
#define EMILY_WHITE lv_color_hex(0xFFFFFF)

// ---- Geometry (inside the cloud group, 240 wide) ----
static const int32_t EMILY_EYE_W = 14, EMILY_EYE_H = 22, EMILY_EYE_Y = 52;
static const int32_t EMILY_EYE_L_X = 98, EMILY_EYE_R_X = 128;
static const int32_t EMILY_MOUTH_W = 14, EMILY_MOUTH_X = 113, EMILY_MOUTH_CY = 86;
static const int32_t EMILY_MOUTH_SHUT_H = 4, EMILY_MOUTH_OPEN_H = 12;

// Line points must stay alive while the line exists (LVGL keeps only the pointer).
static const lv_point_precise_t EMILY_BROW_L_CALM[] = {{96, 45}, {112, 43}};
static const lv_point_precise_t EMILY_BROW_R_CALM[] = {{128, 43}, {144, 45}};
static const lv_point_precise_t EMILY_BROW_L_WORRIED[] = {{96, 46}, {112, 40}};
static const lv_point_precise_t EMILY_BROW_R_WORRIED[] = {{128, 40}, {144, 46}};
static const lv_point_precise_t EMILY_SMILE[] = {{112, 82}, {116, 86}, {124, 86}, {128, 82}};
static const lv_point_precise_t EMILY_FLAT[] = {{114, 85}, {126, 85}};

// ---- State ----
static lv_obj_t *emilyRoot = nullptr;      // full-screen background, parent of everything
static lv_obj_t *emilyCloud = nullptr;     // transparent group: body + face (moves when bobbing)
static lv_obj_t *emilyEyeL = nullptr, *emilyEyeR = nullptr;
static lv_obj_t *emilyBrowL = nullptr, *emilyBrowR = nullptr;
static lv_obj_t *emilyMouthLine = nullptr, *emilyMouthOpen = nullptr;
static lv_obj_t *emilyCaption = nullptr;
static lv_obj_t *emilyOkBtn = nullptr, *emilyHelpBtn = nullptr;
static EmilyMood emilyMood = EmilyMood::Calm;
static void (*emilyOnOk)() = nullptr;
static void (*emilyOnHelp)() = nullptr;
static bool emilyButtonsArmed = false;
static bool emilyEyesClosed = false;
static uint8_t emilyBlinkIndex = 0;
static uint8_t emilyTalkTick = 0;

// A plain rounded shape that does not catch taps or scroll.
static inline lv_obj_t *emilyShape(lv_obj_t *parent, int32_t x, int32_t y, int32_t w, int32_t h,
                                   lv_color_t color, int32_t radius) {
  lv_obj_t *o = lv_obj_create(parent);
  lv_obj_set_pos(o, x, y);
  lv_obj_set_size(o, w, h);
  lv_obj_set_style_bg_color(o, color, 0);
  lv_obj_set_style_bg_opa(o, LV_OPA_COVER, 0);
  lv_obj_set_style_radius(o, radius, 0);
  lv_obj_set_style_border_width(o, 0, 0);
  lv_obj_set_style_shadow_width(o, 0, 0);
  lv_obj_set_style_pad_all(o, 0, 0);
  lv_obj_remove_flag(o, LV_OBJ_FLAG_CLICKABLE);
  lv_obj_remove_flag(o, LV_OBJ_FLAG_SCROLLABLE);
  return o;
}

static inline lv_obj_t *emilyLine(lv_obj_t *parent, const lv_point_precise_t *pts, uint32_t n) {
  lv_obj_t *l = lv_line_create(parent);
  lv_obj_set_pos(l, 0, 0);
  lv_line_set_points(l, pts, n);
  lv_obj_set_style_line_width(l, 3, 0);
  lv_obj_set_style_line_color(l, EMILY_NAVY, 0);
  lv_obj_set_style_line_rounded(l, true, 0);
  lv_obj_remove_flag(l, LV_OBJ_FLAG_CLICKABLE);
  return l;
}

static inline void emilySetEyeHeight(int32_t h) {
  int32_t y = EMILY_EYE_Y + (EMILY_EYE_H - h) / 2;
  lv_obj_set_height(emilyEyeL, h);
  lv_obj_set_height(emilyEyeR, h);
  lv_obj_set_y(emilyEyeL, y);
  lv_obj_set_y(emilyEyeR, y);
}

static inline void emilySetMouthOpenHeight(int32_t h) {
  lv_obj_set_height(emilyMouthOpen, h);
  lv_obj_set_y(emilyMouthOpen, EMILY_MOUTH_CY - h / 2);
}

// One timer: wait, close the eyes for EMILY_BLINK_CLOSED_MS, open them, wait again. Runs in every mood.
static inline void emilyBlinkCb(lv_timer_t *t) {
  if (!emilyEyeL) return;
  if (!emilyEyesClosed) {
    emilyEyesClosed = true;
    emilySetEyeHeight(2);
    lv_timer_set_period(t, EMILY_BLINK_CLOSED_MS);
  } else {
    emilyEyesClosed = false;
    emilySetEyeHeight(EMILY_EYE_H);
    emilyBlinkIndex = (emilyBlinkIndex + 1) % (sizeof(EMILY_BLINK_MS) / sizeof(EMILY_BLINK_MS[0]));
    lv_timer_set_period(t, EMILY_BLINK_MS[emilyBlinkIndex]);
  }
}

// Only does something while Talking: mouth opens and closes, the cloud bobs.
static inline void emilyTalkCb(lv_timer_t *t) {
  (void)t;
  if (!emilyMouthOpen || emilyMood != EmilyMood::Talking) return;
  emilyTalkTick++;
  emilySetMouthOpenHeight((emilyTalkTick & 1) ? EMILY_MOUTH_SHUT_H : EMILY_MOUTH_OPEN_H);
  lv_obj_set_y(emilyCloud, (emilyTalkTick & 2) ? -EMILY_BOB_PX : 0);
}

static inline void emilyFaceHideButtons() {
  emilyButtonsArmed = false;
  if (emilyOkBtn) lv_obj_add_flag(emilyOkBtn, LV_OBJ_FLAG_HIDDEN);
  if (emilyHelpBtn) lv_obj_add_flag(emilyHelpBtn, LV_OBJ_FLAG_HIDDEN);
}

static inline void emilyButtonPressed(void (*cb)()) {
  if (!emilyButtonsArmed) return;  // call the callback once, even on a double tap
  emilyFaceHideButtons();
  if (cb) cb();
}

static inline void emilyOkEvent(lv_event_t *e) {
  if (lv_event_get_code(e) != LV_EVENT_CLICKED) return;
  emilyButtonPressed(emilyOnOk);
}

static inline void emilyHelpEvent(lv_event_t *e) {
  if (lv_event_get_code(e) != LV_EVENT_CLICKED) return;
  emilyButtonPressed(emilyOnHelp);
}

static inline lv_obj_t *emilyButton(lv_obj_t *parent, const char *text, lv_color_t bg,
                                    lv_align_t align, int32_t x, lv_event_cb_t cb) {
  lv_obj_t *btn = lv_button_create(parent);
  lv_obj_set_size(btn, 110, 64);
  lv_obj_align(btn, align, x, -8);
  lv_obj_set_style_bg_color(btn, bg, 0);
  lv_obj_set_style_radius(btn, 18, 0);
  lv_obj_set_style_pad_all(btn, 0, 0);
  lv_obj_add_event_cb(btn, cb, LV_EVENT_CLICKED, NULL);
  lv_obj_t *label = lv_label_create(btn);
  lv_obj_set_style_text_font(label, &lv_font_montserrat_28, 0);
  lv_obj_set_style_text_color(label, EMILY_WHITE, 0);
  lv_label_set_text(label, text);
  lv_obj_center(label);
  lv_obj_add_flag(btn, LV_OBJ_FLAG_HIDDEN);
  return btn;
}

static inline void emilyFaceSetMood(EmilyMood mood) {
  if (!emilyRoot) return;
  emilyMood = mood;
  bool worried = mood == EmilyMood::Worried;
  lv_obj_set_style_bg_color(emilyRoot, worried ? EMILY_CORAL : EMILY_SKY, 0);
  lv_line_set_points(emilyBrowL, worried ? EMILY_BROW_L_WORRIED : EMILY_BROW_L_CALM, 2);
  lv_line_set_points(emilyBrowR, worried ? EMILY_BROW_R_WORRIED : EMILY_BROW_R_CALM, 2);
  if (mood == EmilyMood::Talking) {
    lv_obj_add_flag(emilyMouthLine, LV_OBJ_FLAG_HIDDEN);
    lv_obj_remove_flag(emilyMouthOpen, LV_OBJ_FLAG_HIDDEN);
    emilyTalkTick = 0;
    emilySetMouthOpenHeight(EMILY_MOUTH_OPEN_H);  // open at once, in case playback blocks the timers
  } else {
    lv_obj_add_flag(emilyMouthOpen, LV_OBJ_FLAG_HIDDEN);
    lv_obj_remove_flag(emilyMouthLine, LV_OBJ_FLAG_HIDDEN);
    if (worried) lv_line_set_points(emilyMouthLine, EMILY_FLAT, 2);
    else lv_line_set_points(emilyMouthLine, EMILY_SMILE, 4);
    lv_obj_set_y(emilyCloud, 0);
  }
}

static inline void emilyFaceCreate(lv_obj_t *parent) {
  if (emilyRoot) return;  // build once

  emilyRoot = emilyShape(parent, 0, 0, 240, 240, EMILY_SKY, 0);

  emilyCloud = lv_obj_create(emilyRoot);
  lv_obj_set_pos(emilyCloud, 0, 0);
  lv_obj_set_size(emilyCloud, 240, 120);
  lv_obj_set_style_bg_opa(emilyCloud, LV_OPA_TRANSP, 0);
  lv_obj_set_style_border_width(emilyCloud, 0, 0);
  lv_obj_set_style_shadow_width(emilyCloud, 0, 0);
  lv_obj_set_style_pad_all(emilyCloud, 0, 0);
  lv_obj_remove_flag(emilyCloud, LV_OBJ_FLAG_CLICKABLE);
  lv_obj_remove_flag(emilyCloud, LV_OBJ_FLAG_SCROLLABLE);

  // Cloud body: a wide rounded base and three overlapping puffs.
  emilyShape(emilyCloud, 40, 52, 160, 64, EMILY_CLOUD, 32);
  emilyShape(emilyCloud, 50, 34, 64, 64, EMILY_CLOUD, LV_RADIUS_CIRCLE);
  emilyShape(emilyCloud, 88, 10, 84, 84, EMILY_CLOUD, LV_RADIUS_CIRCLE);
  emilyShape(emilyCloud, 140, 36, 56, 56, EMILY_CLOUD, LV_RADIUS_CIRCLE);

  // Face.
  emilyShape(emilyCloud, 80, 76, 16, 9, EMILY_CHEEK, LV_RADIUS_CIRCLE);
  emilyShape(emilyCloud, 144, 76, 16, 9, EMILY_CHEEK, LV_RADIUS_CIRCLE);
  emilyEyeL = emilyShape(emilyCloud, EMILY_EYE_L_X, EMILY_EYE_Y, EMILY_EYE_W, EMILY_EYE_H, EMILY_NAVY, LV_RADIUS_CIRCLE);
  emilyEyeR = emilyShape(emilyCloud, EMILY_EYE_R_X, EMILY_EYE_Y, EMILY_EYE_W, EMILY_EYE_H, EMILY_NAVY, LV_RADIUS_CIRCLE);
  emilyBrowL = emilyLine(emilyCloud, EMILY_BROW_L_CALM, 2);
  emilyBrowR = emilyLine(emilyCloud, EMILY_BROW_R_CALM, 2);
  emilyMouthLine = emilyLine(emilyCloud, EMILY_SMILE, 4);
  emilyMouthOpen = emilyShape(emilyCloud, EMILY_MOUTH_X, EMILY_MOUTH_CY - EMILY_MOUTH_OPEN_H / 2,
                              EMILY_MOUTH_W, EMILY_MOUTH_OPEN_H, EMILY_NAVY, LV_RADIUS_CIRCLE);
  lv_obj_add_flag(emilyMouthOpen, LV_OBJ_FLAG_HIDDEN);

  // What Emily says, under the cloud.
  emilyCaption = lv_label_create(emilyRoot);
  lv_obj_set_style_text_font(emilyCaption, &lv_font_montserrat_20, 0);
  lv_obj_set_style_text_color(emilyCaption, EMILY_NAVY, 0);
  lv_obj_set_style_text_align(emilyCaption, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_width(emilyCaption, 224);
  lv_label_set_long_mode(emilyCaption, LV_LABEL_LONG_WRAP);
  lv_label_set_text(emilyCaption, "");
  lv_obj_align(emilyCaption, LV_ALIGN_TOP_MID, 0, 122);

  emilyOkBtn = emilyButton(emilyRoot, "I'm OK", EMILY_OK_BG, LV_ALIGN_BOTTOM_LEFT, 6, emilyOkEvent);
  emilyHelpBtn = emilyButton(emilyRoot, "Help", EMILY_HELP_BG, LV_ALIGN_BOTTOM_RIGHT, -6, emilyHelpEvent);

  lv_timer_create(emilyBlinkCb, EMILY_BLINK_MS[0], NULL);
  lv_timer_create(emilyTalkCb, EMILY_TALK_TICK_MS, NULL);
  emilyFaceSetMood(EmilyMood::Calm);
}

static inline void emilyFaceShowButtons(void (*onOk)(), void (*onHelp)()) {
  if (!emilyRoot) return;
  emilyOnOk = onOk;
  emilyOnHelp = onHelp;
  emilyButtonsArmed = true;
  lv_obj_remove_flag(emilyOkBtn, LV_OBJ_FLAG_HIDDEN);
  lv_obj_remove_flag(emilyHelpBtn, LV_OBJ_FLAG_HIDDEN);
}

static inline void emilyFaceShow(bool visible) {
  if (!emilyRoot) return;
  if (visible) lv_obj_remove_flag(emilyRoot, LV_OBJ_FLAG_HIDDEN);
  else lv_obj_add_flag(emilyRoot, LV_OBJ_FLAG_HIDDEN);
}

static inline void emilyFaceSetCaption(const char *text) {
  if (emilyCaption) lv_label_set_text(emilyCaption, text ? text : "");
}
