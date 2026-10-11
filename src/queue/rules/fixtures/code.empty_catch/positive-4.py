def login(user, password):
    try:
        check_password(user, password)
    except Exception:
        pass
    return create_session(user)
