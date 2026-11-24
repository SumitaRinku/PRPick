/**
 * Centralized validation rules
 * Single source of truth for all input validation
 */

const { validationError } = require('../middleware/errorHandler');

const validators = {
    // User validation
    username: (v) => {
        if (!v || typeof v !== 'string') {
            throw validationError('请填写用户名', 'username');
        }
        if (!/^[a-zA-Z0-9_]{3,20}$/.test(v)) {
            throw validationError('用户名须为 3–20 位字母、数字或下划线', 'username');
        }
        return v.trim();
    },

    password: (v) => {
        if (!v || typeof v !== 'string') {
            throw validationError('请填写密码', 'password');
        }
        if (v.length < 6) {
            throw validationError('密码至少 6 位', 'password');
        }
        return v;
    },

    role: (v) => {
        const role = v || 'user';
        if (!['user', 'admin'].includes(role)) {
            throw validationError('角色无效', 'role');
        }
        return role;
    },

    // Match validation
    format: (v) => {
        if (!v || typeof v !== 'string') {
            throw validationError('请选择赛制', 'format');
        }
        if (!['BO1', 'BO3', 'BO5'].includes(v)) {
            throw validationError('赛制无效', 'format');
        }
        return v;
    },

    score: (v, format) => {
        if (!Number.isInteger(v)) {
            throw validationError('比分须为整数', 'score');
        }
        const maxScore = { BO1: 1, BO3: 2, BO5: 3 }[format] || 0;
        if (v < 0 || v > maxScore) {
            throw validationError(`比分范围须为 0–${maxScore}`, 'score');
        }
        return v;
    },

    // Prediction validation
    prediction: (obj, format) => {
        if (!obj || typeof obj !== 'object') {
            throw validationError('预测参数无效');
        }

        const { predicted_winner_id, predicted_team1_score, predicted_team2_score } = obj;

        if (!Number.isInteger(predicted_winner_id)) {
            throw validationError('获胜队伍无效', 'predicted_winner_id');
        }

        validators.score(predicted_team1_score, format);
        validators.score(predicted_team2_score, format);

        return obj;
    },

    // Integer validation
    integer: (v, fieldName = 'value') => {
        if (!Number.isInteger(Number(v))) {
            throw validationError(`${fieldName} 须为整数`, fieldName);
        }
        return Number(v);
    },

    // Positive integer validation
    positiveInteger: (v, fieldName = 'value') => {
        const num = validators.integer(v, fieldName);
        if (num <= 0) {
            throw validationError(`${fieldName} 须为正整数`, fieldName);
        }
        return num;
    },

    // Optional string with max length
    optionalString: (v, maxLen = 255, fieldName = 'value') => {
        if (v === undefined || v === null) return null;
        if (typeof v !== 'string') {
            throw validationError(`${fieldName} 须为文本`, fieldName);
        }
        if (v.length > maxLen) {
            throw validationError(`${fieldName} 最多 ${maxLen} 个字符`, fieldName);
        }
        return v.trim();
    },

    // Email validation (simple)
    email: (v) => {
        if (!v || typeof v !== 'string') {
            throw validationError('请填写邮箱', 'email');
        }
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(v)) {
            throw validationError('邮箱格式无效', 'email');
        }
        return v.toLowerCase().trim();
    },

    // Boolean validation
    boolean: (v) => {
        if (typeof v === 'boolean') return v;
        if (v === 'true') return true;
        if (v === 'false') return false;
        throw validationError('参数须为布尔值', 'value');
    }
};

/**
 * Middleware factory for validating request body
 * Usage: router.post('/endpoint', validate({
 *     username: validators.username,
 *     password: validators.password,
 * }), (req, res, next) => {...})
 */
function validate(schema) {
    return (req, res, next) => {
        try {
            const validated = {};
            for (const [field, validator] of Object.entries(schema)) {
                const value = req.body[field];
                validated[field] = validator(value);
            }
            req.validated = validated;
            next();
        } catch (error) {
            next(error);
        }
    };
}

module.exports = { validators, validate };
