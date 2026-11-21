
      /*
    MIT License
    
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.
    */
import { DataTypes } from "sequelize";
import bcrypt from "bcrypt";
import { sequelize } from "./db.js";

// Passwords are stored only as bcrypt hashes. The hooks below hash any plain password on create/update,
// so every code path (register, Add staff, seed, scripts) is covered; migrate.js converts old plain rows.
export const isHashed = value => /^\$2[aby]\$\d{2}\$/.test(String(value || ""));
const hashIfPlain = async user => {
  if (user.changed("password") && !isHashed(user.password)) user.password = await bcrypt.hash(String(user.password), 10);
};
export const MIN_PASSWORD = 8;

export const User = sequelize.define("User", {
  name: { type: DataTypes.STRING, allowNull: false },
  email: { type: DataTypes.STRING, allowNull: false, unique: true },
  password: { type: DataTypes.STRING, allowNull: false },
  role: { type: DataTypes.ENUM("admin", "staff"), allowNull: false, defaultValue: "staff" },
  deletedById: { type: DataTypes.INTEGER, allowNull: true }
}, {
  // Staff accounts are deactivated (deletedAt = NOW()), never removed, so their log history stays attributable.
  paranoid: true,
  hooks: {
    beforeCreate: hashIfPlain,
    beforeUpdate: hashIfPlain,
    beforeBulkCreate: async users => { for (const u of users) await hashIfPlain(u); },
    beforeDestroy: (instance, options) => { if (options.force) throw new Error("Permanent deletion of staff accounts is disabled."); },
    beforeBulkDestroy: options => { if (options.force) throw new Error("Permanent deletion of staff accounts is disabled."); }
  }
});
export { sequelize }; 

// Constant-time check against the stored bcrypt hash. Legacy plain-text rows (before migrate.js ran)
// are accepted once and immediately re-saved as a hash.
User.prototype.checkPassword = async function (plain) {
  if (isHashed(this.password)) return bcrypt.compare(String(plain || ""), this.password);
  const ok = String(plain || "") === String(this.password || "");
  if (ok) await this.update({ password: String(plain) });
  return ok;
};
