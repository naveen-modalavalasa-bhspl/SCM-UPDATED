"""rbac_ tables — mapped to the canonical scm_rebuild schema."""
from sqlalchemy import BigInteger, Boolean, Column, DateTime, Integer, String

from app.core.database import Base
from app.shared.models.base import utcnow


class Permission(Base):
    __tablename__ = "rbac_permissions"
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    code = Column(String(100), unique=True, nullable=False)
    module = Column(String(50), nullable=False, index=True)
    resource = Column(String(50), nullable=False)
    action = Column(String(50), nullable=False)
    description = Column(String(300), nullable=True)


class Role(Base):
    __tablename__ = "rbac_roles"
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    code = Column(String(50), unique=True, nullable=False)
    name = Column(String(200), nullable=False)
    description = Column(String(300), nullable=True)
    is_system = Column(Boolean, nullable=False, default=False)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime, nullable=False, default=utcnow)


class RolePermission(Base):
    __tablename__ = "rbac_role_permissions"
    role_id = Column(BigInteger, primary_key=True, nullable=False)
    permission_id = Column(BigInteger, primary_key=True, nullable=False)


class UserRole(Base):
    __tablename__ = "rbac_user_roles"
    employee_id = Column(BigInteger, primary_key=True, nullable=False)
    role_id = Column(BigInteger, primary_key=True, nullable=False)
    assigned_by_id = Column(BigInteger, nullable=True)
    assigned_at = Column(DateTime, nullable=False, default=utcnow)


class Page(Base):
    __tablename__ = "rbac_pages"
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    code = Column(String(50), unique=True, nullable=False)
    path = Column(String(200), nullable=False)
    name = Column(String(200), nullable=False)
    icon = Column(String(50), nullable=True)
    module = Column(String(50), nullable=True)
    parent_id = Column(BigInteger, index=True, nullable=True)
    sort_order = Column(Integer, nullable=False, default=0)
    required_permission = Column(String(100), nullable=True)
    show_on_mobile = Column(Boolean, nullable=False, default=True)
    is_active = Column(Boolean, nullable=False, default=True)
