// POST /api/auth/signin
router.post('/signin', async (req, res) => {
  try {
    const identifier = String(req.body?.identifier || '').trim()
    const password = String(req.body?.password || '')

    if (!identifier || !password)
      return res.status(400).json({ error: 'Missing credentials' })

    // Decide if it's an email or username
    const isEmail = identifier.includes('@')
    const query = isEmail
      ? { email: identifier.toLowerCase() }
      : { username: identifier }

    const u = await User.findOne(query)
    if (!u || !(await bcrypt.compare(password, u.passwordHash))) {
      return res.status(400).json({ error: 'Invalid credentials' })
    }

    const token = signAccess({
      sub: u._id.toString(),
      email: u.email,
      name: u.name,
      username: u.username || null,
      color: u.color,
    })
    setAuthCookie(res, token)

    res.json({
      ok: true,
      user: { id: u._id, email: u.email, name: u.name, username: u.username || null, color: u.color },
    })
  } catch (err) {
    console.error('[signin] error', err)
    res.status(500).json({ error: 'Server error' })
  }
})
