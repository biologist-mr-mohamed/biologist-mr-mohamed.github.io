/* نظام الصور الرمزية والإطارات - v5.0.0 */

// ==== 1. ثوابت المسارات والأبعاد ====
const AVATAR_CONFIG = {
  SPRITE: {
    MALE:       '/assets/avatars/jobs/avatars_male.png',
    FEMALE:     '/assets/avatars/jobs/avatars_female.png',
    MALE_BG:    '/assets/images/M.png',
    FEMALE_BG:  '/assets/images/G.png',
    TEACHER:    '/assets/images/biologist.png',
    TOTAL_COLS: 5,
    TOTAL_ROWS: 2,
  },

  FRAME_CLASSES: {
    teacher:        'avatar-frame--teacher',
    moderator:      'avatar-frame--moderator',
    student_bronze: 'avatar-frame--bronze',
    student_silver: 'avatar-frame--silver',
    student_gold:   'avatar-frame--gold',
    guest:          'avatar-frame--guest',
  },

  SCORE_THRESHOLDS: {
    GOLD:   400,
    SILVER: 200,
  },

  VERIFICATION_BADGE_CLASS: 'verification-badge',

  SIZES: ['sm', 'md', 'lg', 'xl'],

  DEFAULT_JOB_INDEX: -1,
  DEFAULT_JOB_LABEL: 'الصورة الافتراضية',

  JOB_NAMES: {
    male:   ['طبيب', 'مهندس', 'مزارع', 'عالِم', 'معلّم', 'ميكانيكي', 'ممرّض', 'ضابط', 'محامٍ', 'رجل أعمال'],
    female: ['طبيبة', 'مهندسة', 'مزارعة', 'عالِمة', 'معلّمة', 'ميكانيكية', 'ممرّضة', 'ضابطة', 'محامية', 'سيدة أعمال'],
  },
};

// ==== 2. حساب موقع الـ Sprite ====

function _calcSpritePercent(col, row) {
  const maxCols = AVATAR_CONFIG.SPRITE.TOTAL_COLS - 1;
  const maxRows = AVATAR_CONFIG.SPRITE.TOTAL_ROWS - 1;

  const percentX = maxCols > 0 ? (col / maxCols) * 100 : 0;
  const percentY = maxRows > 0 ? (row / maxRows) * 100 : 0;

  return { percentX, percentY };
}

// ==== 3. تطبيع رقم الوظيفة ====

export function getAvatarJobIndex(user) {
  const raw = Number(user?.avatar_job_index);
  if (!Number.isFinite(raw) || raw < 0) return 0;
  const total = AVATAR_CONFIG.SPRITE.TOTAL_COLS * AVATAR_CONFIG.SPRITE.TOTAL_ROWS;
  return Math.floor(raw) % total;
}

export function hasChosenAvatarJob(user) {
  const value = user?.avatar_job_index;
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return false;
  const raw = Number(value);
  return Number.isFinite(raw) && raw >= 0;
}

export function getAvatarJobSelection(user) {
  return hasChosenAvatarJob(user) ? getAvatarJobIndex(user) : AVATAR_CONFIG.DEFAULT_JOB_INDEX;
}

function _resolveGender(user) {
  return user?.gender === 'female' ? 'female' : 'male';
}

export function getAvatarJobs(user) {
  return AVATAR_CONFIG.JOB_NAMES[_resolveGender(user)].map((name, index) => ({ index, name }));
}

export function getAvatarJobName(user) {
  const selection = getAvatarJobSelection(user);
  if (selection < 0) return AVATAR_CONFIG.DEFAULT_JOB_LABEL;
  return AVATAR_CONFIG.JOB_NAMES[_resolveGender(user)][selection];
}

export function canChooseJobAvatar(user) {
  return Boolean(user?.id) && (user.user_type === 'student' || user.user_type === 'moderator');
}

export function getAvatarSpriteUrl(user) {
  return _resolveGender(user) === 'female' ? AVATAR_CONFIG.SPRITE.FEMALE : AVATAR_CONFIG.SPRITE.MALE;
}

export function getAvatarJobSpriteStyle(user, index) {
  const safeIndex = getAvatarJobIndex({ avatar_job_index: index });
  const col = safeIndex % AVATAR_CONFIG.SPRITE.TOTAL_COLS;
  const row = Math.floor(safeIndex / AVATAR_CONFIG.SPRITE.TOTAL_COLS);
  const { percentX, percentY } = _calcSpritePercent(col, row);

  return {
    backgroundImage:    `url('${getAvatarSpriteUrl(user)}')`,
    backgroundSize:     `${AVATAR_CONFIG.SPRITE.TOTAL_COLS * 100}% ${AVATAR_CONFIG.SPRITE.TOTAL_ROWS * 100}%`,
    backgroundPosition: `${percentX}% ${percentY}%`,
    backgroundRepeat:   'no-repeat',
  };
}

// ==== 4. حساب نمط الخلفية ====

export function getAvatarStyle(user) {

  if (user?.user_type === 'teacher') {
    return {
      backgroundImage:    `url('${AVATAR_CONFIG.SPRITE.TEACHER}')`,
      backgroundSize:     'cover',
      backgroundPosition: 'center top',
      backgroundRepeat:   'no-repeat',
      isTeacher:          true,
      isDefault:          false,
    };
  }

  const base = {
    backgroundImage:    `url('${getAvatarFallbackImage(user)}')`,
    backgroundSize:     'cover',
    backgroundPosition: 'center',
    backgroundRepeat:   'no-repeat',
    isTeacher:          false,
  };

  if (!hasChosenAvatarJob(user)) {
    return { ...base, isDefault: true };
  }

  const sprite = getAvatarJobSpriteStyle(user, getAvatarJobIndex(user));

  return {
    ...base,
    spriteImage:    sprite.backgroundImage,
    spriteSize:     sprite.backgroundSize,
    spritePosition: sprite.backgroundPosition,
    isDefault:      false,
  };
}

// ==== 5. إنشاء عنصر الصورة الرمزية ====

export function createAvatarElement(user, size = 'md', options = {}) {
  const {
    showFrame   = true,
    showBadge   = true,
    clickable   = true,
    onClick     = null,
    showShimmer = false,
    showPulse   = false,
    editable    = false,
    onEdit      = null,
  } = options;

  const safeSize = AVATAR_CONFIG.SIZES.includes(size) ? size : 'md';

  const wrapper = document.createElement('div');
  wrapper.className = `avatar-wrapper avatar-wrapper--${safeSize}`;
  if (user?.id) wrapper.setAttribute('data-user-id', user.id);
  wrapper.setAttribute('data-user-type', user?.user_type || 'guest');
  wrapper.setAttribute('data-show-frame', String(Boolean(showFrame)));

  if (showPulse && user) {
    const pulse = document.createElement('div');
    pulse.className = 'avatar-pulse-ring';
    pulse.setAttribute('aria-hidden', 'true');
    wrapper.appendChild(pulse);
  }

  const frame = document.createElement('div');
  const frameClass = getFrameClass(user);
  frame.className = showFrame
    ? `avatar-frame ${frameClass}`
    : 'avatar-frame avatar-frame--guest';
  frame.setAttribute('aria-hidden', 'true');

  const style    = getAvatarStyle(user);
  const imageDiv = document.createElement('div');
  imageDiv.className = 'avatar-image';
  imageDiv.style.backgroundImage    = style.backgroundImage;
  imageDiv.style.backgroundSize     = style.backgroundSize;
  imageDiv.style.backgroundPosition = style.backgroundPosition;
  imageDiv.style.backgroundRepeat   = style.backgroundRepeat;

  if (!style.isTeacher && style.spriteImage) {
    const spriteDiv = document.createElement('div');
    spriteDiv.className                = 'avatar-sprite-layer';
    spriteDiv.style.backgroundImage    = style.spriteImage;
    spriteDiv.style.backgroundSize     = style.spriteSize;
    spriteDiv.style.backgroundPosition = style.spritePosition;
    spriteDiv.style.backgroundRepeat   = 'no-repeat';
    spriteDiv.setAttribute('aria-hidden', 'true');
    imageDiv.appendChild(spriteDiv);
  }

  if (showShimmer) {
    const shimmer = document.createElement('div');
    shimmer.className = 'avatar-shimmer';
    shimmer.setAttribute('aria-hidden', 'true');
    imageDiv.appendChild(shimmer);
  }

  frame.appendChild(imageDiv);
  wrapper.appendChild(frame);
  _watchTeacherImage(imageDiv, user);

  if (showBadge && shouldShowVerificationBadge(user)) {
    const badge = _createVerificationBadge(user);
    wrapper.appendChild(badge);
  }

  const hasEditButton = editable && typeof onEdit === 'function' && Boolean(user?.id);
  if (hasEditButton) {
    wrapper.appendChild(_createEditButton(user, onEdit));
  }

  if (clickable && onClick && user?.id) {
    wrapper.style.cursor = 'pointer';
    wrapper.setAttribute('role', 'button');
    wrapper.setAttribute('tabindex', '0');
    wrapper.setAttribute('aria-label', `عرض ملف ${user.full_name || user.username || 'المستخدم'}`);

    const currentId = () => wrapper.getAttribute('data-user-id') || user.id;
    const handleClick = (e) => {
      e.stopPropagation();
      onClick(currentId());
    };
    const handleKeyDown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onClick(currentId());
      }
    };

    wrapper.addEventListener('click', handleClick);
    wrapper.addEventListener('keydown', handleKeyDown);

    wrapper._clickHandler   = handleClick;
    wrapper._keydownHandler = handleKeyDown;
  } else if (!hasEditButton) {
    wrapper.setAttribute('role', 'img');
    wrapper.setAttribute('aria-label', _getImageLabel(user));
  }

  return wrapper;
}

// ==== 6. تحديث عنصر موجود ====

export function updateAvatarElement(element, user) {
  if (!element) return;

  if (user?.id) element.setAttribute('data-user-id', user.id);
  else element.removeAttribute('data-user-id');
  element.setAttribute('data-user-type', user?.user_type || 'guest');

  if (element.getAttribute('role') === 'button') {
    element.setAttribute('aria-label', `عرض ملف ${user?.full_name || user?.username || 'المستخدم'}`);
  } else if (element.getAttribute('role') === 'img') {
    element.setAttribute('aria-label', _getImageLabel(user));
  }

  const frame = element.querySelector('.avatar-frame');
  if (frame) {
    const allFrameClasses = Object.values(AVATAR_CONFIG.FRAME_CLASSES);
    allFrameClasses.forEach(cls => frame.classList.remove(cls));
    const framed = element.getAttribute('data-show-frame') !== 'false';
    frame.classList.add(framed ? getFrameClass(user) : AVATAR_CONFIG.FRAME_CLASSES.guest);
  }

  const style    = getAvatarStyle(user);
  const imageDiv = element.querySelector('.avatar-image');
  if (imageDiv) {
    imageDiv.style.backgroundImage    = style.backgroundImage;
    imageDiv.style.backgroundSize     = style.backgroundSize;
    imageDiv.style.backgroundPosition = style.backgroundPosition;
    imageDiv.style.backgroundRepeat   = style.backgroundRepeat;

    let spriteDiv = imageDiv.querySelector('.avatar-sprite-layer');

    if (!style.isTeacher && style.spriteImage) {
      if (!spriteDiv) {
        spriteDiv = document.createElement('div');
        spriteDiv.className = 'avatar-sprite-layer';
        spriteDiv.setAttribute('aria-hidden', 'true');
        imageDiv.appendChild(spriteDiv);
      }
      spriteDiv.style.backgroundImage    = style.spriteImage;
      spriteDiv.style.backgroundSize     = style.spriteSize;
      spriteDiv.style.backgroundPosition = style.spritePosition;
      spriteDiv.style.backgroundRepeat   = 'no-repeat';
    } else if (spriteDiv) {
      spriteDiv.remove();
    }

    _watchTeacherImage(imageDiv, user);
  }

  const existingBadge = element.querySelector(`.${AVATAR_CONFIG.VERIFICATION_BADGE_CLASS}`);
  const shouldShow    = shouldShowVerificationBadge(user);

  if (shouldShow && !existingBadge) {
    const badge = _createVerificationBadge(user);
    element.appendChild(badge);
  } else if (shouldShow && existingBadge) {
    _updateBadgeColor(existingBadge, user);
  } else if (!shouldShow && existingBadge) {
    existingBadge.remove();
  }
}

// ==== 7. تحديد كلاس الإطار ====

export function getFrameClass(user) {
  if (!user) return AVATAR_CONFIG.FRAME_CLASSES.guest;

  switch (user.user_type) {
    case 'teacher':
      return AVATAR_CONFIG.FRAME_CLASSES.teacher;

    case 'moderator':
      return AVATAR_CONFIG.FRAME_CLASSES.moderator;

    case 'student': {
      const score = _resolveStudentScore(user);
      if (score >= AVATAR_CONFIG.SCORE_THRESHOLDS.GOLD)   return AVATAR_CONFIG.FRAME_CLASSES.student_gold;
      if (score >= AVATAR_CONFIG.SCORE_THRESHOLDS.SILVER) return AVATAR_CONFIG.FRAME_CLASSES.student_silver;
      return AVATAR_CONFIG.FRAME_CLASSES.student_bronze;
    }

    default:
      return AVATAR_CONFIG.FRAME_CLASSES.guest;
  }
}

// ==== 8. عرض علامة التوثيق ====

export function shouldShowVerificationBadge(user) {
  if (!user) return false;
  const isStaff = user.user_type === 'teacher' || user.user_type === 'moderator';
  return isStaff && (user.is_verified !== false);
}

// ==== 9. الصورة الاحتياطية ====

export function getAvatarFallbackImage(user) {
  const gender = user?.gender === 'female' ? 'female' : 'male';
  return gender === 'female'
    ? AVATAR_CONFIG.SPRITE.FEMALE_BG
    : AVATAR_CONFIG.SPRITE.MALE_BG;
}

// ==== 10. تطبيق سريع على عنصر ====

export function applyAvatarToElement(element, user) {
  if (!element) return;
  const style = getAvatarStyle(user);
  element.style.backgroundImage    = style.backgroundImage;
  element.style.backgroundSize     = style.backgroundSize;
  element.style.backgroundPosition = style.backgroundPosition;
  element.style.backgroundRepeat   = style.backgroundRepeat;
}

// ==== 11. إعدادات الأفاتار ====
export function getAvatarConfig() {
  return Object.freeze({
    ...AVATAR_CONFIG,
    SPRITE:           Object.freeze({ ...AVATAR_CONFIG.SPRITE }),
    FRAME_CLASSES:    Object.freeze({ ...AVATAR_CONFIG.FRAME_CLASSES }),
    SCORE_THRESHOLDS: Object.freeze({ ...AVATAR_CONFIG.SCORE_THRESHOLDS }),
    SIZES:            Object.freeze([...AVATAR_CONFIG.SIZES]),
  });
}

// ==== 12. دوال مساعدة داخلية ====

function _createVerificationBadge(user) {
  const badge = document.createElement('div');
  badge.className = AVATAR_CONFIG.VERIFICATION_BADGE_CLASS;
  badge.setAttribute('aria-label', _getBadgeLabel(user));
  badge.setAttribute('title',      _getBadgeLabel(user));
  badge.innerHTML = '<i class="fas fa-check-circle" aria-hidden="true"></i>';
  _updateBadgeColor(badge, user);
  return badge;
}

function _updateBadgeColor(badge, user) {
  badge.classList.remove('badge--teacher', 'badge--moderator');
  if (user?.user_type === 'teacher')   badge.classList.add('badge--teacher');
  if (user?.user_type === 'moderator') badge.classList.add('badge--moderator');
}

function _createEditButton(user, onEdit) {
  const btn = document.createElement('button');
  btn.type      = 'button';
  btn.className = 'avatar-edit-btn';
  btn.setAttribute('aria-label', 'تغيير الصورة الشخصية');
  btn.setAttribute('title',      'تغيير الصورة الشخصية');
  btn.innerHTML = '<i class="fas fa-camera" aria-hidden="true"></i>';
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onEdit(user.id);
  });
  return btn;
}

function _getImageLabel(user) {
  const name = user?.full_name || user?.username;
  return name ? `الصورة الشخصية لـ ${name}` : 'صورة شخصية';
}

function _getBadgeLabel(user) {
  if (user?.user_type === 'teacher')   return 'حساب معلم موثَّق';
  if (user?.user_type === 'moderator') return 'حساب مشرف موثَّق';
  return 'حساب موثَّق';
}

function _resolveStudentScore(user) {
  const score = Number(user.total_score);
  return Number.isFinite(score) && score >= 0 ? score : 0;
}

// ==== 13. فحص صورة المعلم ====
const _probeCache = new Map();

function _watchTeacherImage(imageDiv, user) {
  if (user?.user_type !== 'teacher' || typeof Image === 'undefined') return;

  const url = AVATAR_CONFIG.SPRITE.TEACHER;
  const applyFallback = () => {
    imageDiv.style.backgroundImage = `url('${getAvatarFallbackImage(user)}')`;
    imageDiv.style.backgroundPosition = 'center';
  };

  const known = _probeCache.get(url);
  if (known === 'fail') { applyFallback(); return; }
  if (known === 'ok') return;

  const probe = new Image();
  probe.onload  = () => _probeCache.set(url, 'ok');
  probe.onerror = () => { _probeCache.set(url, 'fail'); applyFallback(); };
  probe.src = url;
}
